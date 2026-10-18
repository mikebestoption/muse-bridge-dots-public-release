'use strict';

// Muse Bridge v0.3.3 — auto-updater module checks.
// Run: node tests/updater.test.js
//
// Plain node + assert only: no electron, no electron-updater. The
// factory takes an injected autoUpdater, so a small EventEmitter fake
// exercises the full wiring — feed config, renderer forwarding, the
// packaged guard, and the download-gated install.

const assert = require('assert');
const { EventEmitter } = require('events');
const {
  createUpdater,
  normalizeStatus,
  isPackagedGuard,
  GITHUB_OWNER,
  GITHUB_REPO,
  FEED_CONFIG,
  STATUS_CHANNEL
} = require('../src/updater');

let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
  console.log('  ✓', name);
}

// ---- fakes ----

class FakeAutoUpdater extends EventEmitter {
  constructor() {
    super();
    this.autoDownload = undefined;
    this.autoInstallOnAppQuit = undefined;
    this.feedCalls = [];
    this.checkCalls = 0;
    this.quitCalls = [];
  }
  setFeedURL(config) { this.feedCalls.push(config); }
  checkForUpdates() {
    this.checkCalls += 1;
    this.emit('checking-for-update');
    return Promise.resolve({ updateInfo: { version: '0.3.4' } });
  }
  quitAndInstall(...args) { this.quitCalls.push(args); }
}

function fakeWindow() {
  const sent = [];
  return {
    sent,
    webContents: {
      send: (channel, payload) => sent.push([channel, payload])
    }
  };
}

function makeUpdater(overrides = {}) {
  const autoUpdater = overrides.autoUpdater || new FakeAutoUpdater();
  const win = overrides.win || fakeWindow();
  const logs = [];
  const updater = createUpdater({
    autoUpdater,
    app: 'app' in overrides ? overrides.app : { isPackaged: true },
    getWindow: 'getWindow' in overrides ? overrides.getWindow : () => win,
    log: (msg) => logs.push(String(msg))
  });
  return { updater, autoUpdater, win, logs };
}

// ---- pure helpers: constants / feed ----

check('feed targets the public repo, with no credentials', () => {
  assert.strictEqual(GITHUB_OWNER, 'mikebestoption');
  assert.strictEqual(GITHUB_REPO, 'muse-bridge-dots-public-release');
  assert.deepStrictEqual(FEED_CONFIG, {
    provider: 'github',
    owner: 'mikebestoption',
    repo: 'muse-bridge-dots-public-release'
  });
  // The whole config is exactly provider/owner/repo — no token field
  // can sneak in without this test noticing.
  assert.deepStrictEqual(Object.keys(FEED_CONFIG).sort(), ['owner', 'provider', 'repo']);
  assert.strictEqual(STATUS_CHANNEL, 'updater:status');
});

// ---- pure helpers: isPackagedGuard ----

check('isPackagedGuard: boolean isPackaged is honored', () => {
  assert.strictEqual(isPackagedGuard({ isPackaged: true }), true);
  assert.strictEqual(isPackagedGuard({ isPackaged: false }), false);
});

check('isPackagedGuard: missing app / missing flag allows the check', () => {
  assert.strictEqual(isPackagedGuard(undefined), true);
  assert.strictEqual(isPackagedGuard(null), true);
  assert.strictEqual(isPackagedGuard({}), true);
});

check('isPackagedGuard: function-valued isPackaged is read defensively', () => {
  assert.strictEqual(isPackagedGuard({ isPackaged: () => false }), false);
  assert.strictEqual(isPackagedGuard({ isPackaged: () => true }), true);
  assert.strictEqual(isPackagedGuard({ isPackaged: () => { throw new Error('boom'); } }), true);
});

// ---- pure helpers: normalizeStatus ----

check('normalizeStatus: checking / available / not-available / downloaded', () => {
  assert.deepStrictEqual(normalizeStatus('checking-for-update'), { state: 'checking', info: {} });
  assert.deepStrictEqual(
    normalizeStatus('update-available', { version: '0.3.4' }),
    { state: 'available', info: { version: '0.3.4' } }
  );
  assert.deepStrictEqual(
    normalizeStatus('update-not-available', { version: '0.3.3' }),
    { state: 'not-available', info: { version: '0.3.3' } }
  );
  assert.deepStrictEqual(
    normalizeStatus('update-downloaded', { version: '0.3.4' }),
    { state: 'downloaded', info: { version: '0.3.4' } }
  );
});

check('normalizeStatus: downloading carries a clamped percent', () => {
  const s = normalizeStatus('download-progress', { percent: 42.5, transferred: 10, total: 24 });
  assert.strictEqual(s.state, 'downloading');
  assert.strictEqual(s.info.percent, 42.5);
  assert.strictEqual(s.info.transferred, 10);
  assert.strictEqual(normalizeStatus('download-progress', { percent: 250 }).info.percent, 100);
  assert.strictEqual(normalizeStatus('download-progress', { percent: -3 }).info.percent, 0);
  assert.strictEqual(normalizeStatus('download-progress', {}).info.percent, 0);
  assert.strictEqual(normalizeStatus('download-progress').info.percent, 0);
});

check('normalizeStatus: errors are honest strings', () => {
  assert.deepStrictEqual(
    normalizeStatus('error', new Error('network unreachable')),
    { state: 'error', info: { message: 'network unreachable' } }
  );
  assert.strictEqual(normalizeStatus('error', 'plain failure').info.message, 'plain failure');
  assert.strictEqual(normalizeStatus('error', { message: 'bad feed' }).info.message, 'bad feed');
  assert.ok(normalizeStatus('error').info.message.length > 0);
});

check('normalizeStatus: unknown events become an honest error, never fake success', () => {
  const s = normalizeStatus('some-future-event', {});
  assert.strictEqual(s.state, 'error');
  assert.ok(s.info.message.includes('some-future-event'));
});

// ---- factory: feed config + flags ----

check('factory configures the public GitHub feed and safe flags', () => {
  const { autoUpdater } = makeUpdater();
  assert.strictEqual(autoUpdater.feedCalls.length, 1, 'setFeedURL called exactly once');
  assert.deepStrictEqual(autoUpdater.feedCalls[0], {
    provider: 'github',
    owner: 'mikebestoption',
    repo: 'muse-bridge-dots-public-release'
  });
  assert.strictEqual(autoUpdater.autoDownload, true, 'background download is on');
  assert.strictEqual(autoUpdater.autoInstallOnAppQuit, false, 'never installs silently on quit');
});

// ---- factory: check forwarding + packaged guard ----

check('checkNow forwards to checkForUpdates', () => {
  const { updater, autoUpdater } = makeUpdater();
  const res = updater.checkNow();
  assert.strictEqual(res.checked, true);
  assert.strictEqual(autoUpdater.checkCalls, 1);
});

check('checkOnLaunch forwards when packaged', () => {
  const { updater, autoUpdater } = makeUpdater();
  const res = updater.checkOnLaunch();
  assert.strictEqual(res.checked, true);
  assert.strictEqual(autoUpdater.checkCalls, 1);
});

check('checkOnLaunch is a no-op when the app is not packaged', () => {
  const { updater, autoUpdater, win } = makeUpdater({ app: { isPackaged: false } });
  const res = updater.checkOnLaunch();
  assert.strictEqual(res.checked, false);
  assert.strictEqual(res.reason, 'not-packaged');
  assert.strictEqual(autoUpdater.checkCalls, 0, 'no check reaches the updater in dev');
  assert.strictEqual(win.sent.length, 0, 'launch check stays silent in dev');
});

check('checkNow in dev reports honestly instead of checking', () => {
  const { updater, autoUpdater, win } = makeUpdater({ app: { isPackaged: false } });
  const res = updater.checkNow();
  assert.strictEqual(res.checked, false);
  assert.strictEqual(autoUpdater.checkCalls, 0);
  const errors = win.sent.filter(([, p]) => p.state === 'error');
  assert.strictEqual(errors.length, 1);
  assert.ok(errors[0][1].info.message.includes('not packaged'));
});

check('checkNow without any app still forwards (guard only applies if provided)', () => {
  const { updater, autoUpdater } = makeUpdater({ app: undefined });
  assert.strictEqual(updater.checkNow().checked, true);
  assert.strictEqual(autoUpdater.checkCalls, 1);
});

check('checkNow without a configured updater is an honest error', () => {
  const win = fakeWindow();
  const updater = createUpdater({ autoUpdater: null, app: { isPackaged: true }, getWindow: () => win, log: () => {} });
  const res = updater.checkNow();
  assert.strictEqual(res.checked, false);
  assert.strictEqual(win.sent.length, 1);
  assert.strictEqual(win.sent[0][1].state, 'error');
});

// ---- factory: renderer forwarding ----

check('updater events are forwarded to the renderer as updater:status', () => {
  const { autoUpdater, win } = makeUpdater();
  autoUpdater.emit('checking-for-update');
  autoUpdater.emit('update-available', { version: '0.3.4' });
  autoUpdater.emit('download-progress', { percent: 55, transferred: 11, total: 20 });
  autoUpdater.emit('update-downloaded', { version: '0.3.4' });

  assert.deepStrictEqual(
    win.sent.map(([channel]) => channel),
    [STATUS_CHANNEL, STATUS_CHANNEL, STATUS_CHANNEL, STATUS_CHANNEL]
  );
  assert.deepStrictEqual(
    win.sent.map(([, payload]) => payload.state),
    ['checking', 'available', 'downloading', 'downloaded']
  );
  assert.strictEqual(win.sent[2][1].info.percent, 55, 'downloading carries percent');
  assert.strictEqual(win.sent[1][1].info.version, '0.3.4');
});

check('update-not-available and error events are forwarded too', () => {
  const { autoUpdater, win } = makeUpdater();
  autoUpdater.emit('update-not-available', { version: '0.3.3' });
  autoUpdater.emit('error', new Error('feed returned 404'));
  assert.deepStrictEqual(win.sent.map(([, p]) => p.state), ['not-available', 'error']);
  assert.strictEqual(win.sent[1][1].info.message, 'feed returned 404');
});

check('a missing or closed window never breaks event handling', () => {
  const { autoUpdater } = makeUpdater({ getWindow: () => null });
  autoUpdater.emit('update-available', { version: '0.3.4' }); // must not throw
  const { autoUpdater: au2 } = makeUpdater({
    getWindow: () => { throw new Error('window gone'); }
  });
  au2.emit('update-downloaded', { version: '0.3.4' }); // must not throw
});

// ---- factory: download-gated install ----

check('requestInstall refuses before any download completes', () => {
  const { updater, autoUpdater } = makeUpdater();
  assert.strictEqual(updater.isDownloaded(), false);
  assert.strictEqual(updater.requestInstall(), false);
  assert.strictEqual(autoUpdater.quitCalls.length, 0, 'quitAndInstall was not called');

  // Even an *available* (but not yet downloaded) update must refuse.
  autoUpdater.emit('update-available', { version: '0.3.4' });
  autoUpdater.emit('download-progress', { percent: 99 });
  assert.strictEqual(updater.requestInstall(), false);
  assert.strictEqual(autoUpdater.quitCalls.length, 0);
});

check('requestInstall calls quitAndInstall(false, true) after download completes', () => {
  const { updater, autoUpdater } = makeUpdater();
  autoUpdater.emit('update-downloaded', { version: '0.3.4' });
  assert.strictEqual(updater.isDownloaded(), true);
  assert.strictEqual(updater.requestInstall(), true);
  assert.deepStrictEqual(autoUpdater.quitCalls, [[false, true]]);

  // promptRestart is the same gated flow.
  assert.strictEqual(updater.promptRestart(), true);
  assert.deepStrictEqual(autoUpdater.quitCalls, [[false, true], [false, true]]);
});

check('a fresh check resets the gate — no stale install', () => {
  const { updater, autoUpdater } = makeUpdater();
  autoUpdater.emit('update-downloaded', { version: '0.3.4' });
  assert.strictEqual(updater.isDownloaded(), true);
  autoUpdater.emit('checking-for-update');
  assert.strictEqual(updater.isDownloaded(), false);
  assert.strictEqual(updater.requestInstall(), false);
  assert.strictEqual(autoUpdater.quitCalls.length, 0);
});

console.log(`\nupdater.test.js: ALL ${passed} CHECKS PASS`);
