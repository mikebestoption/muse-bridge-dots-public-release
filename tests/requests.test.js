'use strict';

// Ask Muse (v0.4.1) — core format tests + the GitHub channel against
// a FAKE GitHub Contents API (injected fetch; no test ever touches the
// network) + the Settings GitHub-token storage. Covered per spec:
//   - request id (ET timestamp + slug) and collision suffixing
//   - request file format: header block + verbatim text round-trip
//   - status file parsing (all statuses, version, note, CRLF)
//   - draft fallback with NO token (nothing is "sent")
//   - send failure → send-failed draft; retry is idempotent (a file
//     that already landed is never duplicated under a second id)
//   - refresh: discovers other machines' requests + statuses, caches;
//     offline refresh returns the cache, flagged offline
//   - token redaction: the token never lands in the local store file,
//     the request files, the status cache, or any returned object
//   - the client refuses any path outside requests/
// Run: node tests/requests.test.js

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const core = require('../src/requestsCore');
const { createGitHubClient, createRequestsChannel, OWNER, REPO } = require('../src/githubRequests');
const { createSettingsStore } = require('../src/settingsStore');

const FAKE_TOKEN = 'FAKE-GH-TOKEN-1234567890';

// ---------- core: ids ----------
{
  const id = core.makeRequestId(new Date('2026-10-18T09:15:00.000Z'), 'Add a dark-mode toggle please');
  assert.strictEqual(id, 'REQ-20261018-051500-add-a-dark-mode-toggle-please', 'id uses ET wall time (09:15Z = 05:15 EDT)');
  const winter = core.makeRequestId(new Date('2026-01-15T12:00:00.000Z'), 'Winter check');
  assert.strictEqual(winter, 'REQ-20260115-070000-winter-check', 'EST offset in winter');
  const lateNight = core.makeRequestId(new Date('2026-10-18T02:30:00.000Z'), 'Late night idea');
  assert.strictEqual(lateNight, 'REQ-20261017-223000-late-night-idea', 'ET date can lag the UTC date');
  assert.ok(core.isRequestId(id));
  assert.ok(!core.isRequestId('REQ-2026-10-18-nope'));
  assert.strictEqual(core.slugify('  Hello, World!! — v2  '), 'hello-world-v2');
  assert.strictEqual(core.slugify(''), 'request');
  assert.strictEqual(core.slugify('x'.repeat(80)).length, 40, 'slug capped at 40');
  assert.strictEqual(core.requestTitle('  \n  First line here\nsecond'), 'First line here');
  assert.strictEqual(core.uniqueRequestId('REQ-1', new Set(['REQ-1'])), 'REQ-1-2');
  assert.strictEqual(core.uniqueRequestId('REQ-1', ['REQ-1', 'REQ-1-2']), 'REQ-1-3');
  assert.strictEqual(core.uniqueRequestId('REQ-9', []), 'REQ-9');
  assert.strictEqual(core.requestFilePath('REQ-1'), 'requests/REQ-1.md');
  assert.strictEqual(core.statusFilePath('REQ-1'), 'requests/REQ-1/status.md');
  console.log('  ✓ core: ET ids, slugs, titles, collisions, paths');
}

// ---------- core: request file round-trip ----------
{
  const text = 'Hey, I want a dark mode.\n\nDetails:\n---\nthat line above is mine, keep it verbatim  \nThanks!';
  const file = core.buildRequestFile({
    id: 'REQ-20261018-051500-dark', type: 'feature',
    createdAt: '2026-10-18T09:15:00.000Z', machine: 'TEST-PC', appVersion: '0.4.1', text
  });
  const parsed = core.parseRequestFile(file);
  assert.strictEqual(parsed.id, 'REQ-20261018-051500-dark');
  assert.strictEqual(parsed.type, 'feature');
  assert.strictEqual(parsed.createdAt, '2026-10-18T09:15:00.000Z');
  assert.strictEqual(parsed.machine, 'TEST-PC');
  assert.strictEqual(parsed.appVersion, '0.4.1');
  assert.strictEqual(parsed.repoStatus, 'new');
  assert.strictEqual(parsed.text, text, 'the request text round-trips VERBATIM (incl. its own --- line)');
  assert.strictEqual(core.parseRequestFile('no header here'), null);
  assert.strictEqual(core.parseRequestFile('id: nope\n---\nx'), null, 'bad id rejected');
  const badType = core.buildRequestFile({ id: 'REQ-20261018-051500-x', type: 'bogus', createdAt: '', machine: '', appVersion: '', text: 't' });
  assert.strictEqual(core.parseRequestFile(badType).type, 'task', 'unknown type falls back to task');
  console.log('  ✓ core: request file build/parse round-trip, verbatim body');
}

// ---------- core: status file parsing ----------
{
  const full = core.parseStatusFile('status: shipped\nversion: 0.4.2\nupdated: 2026-10-18T14:03:11.000Z\n---\nIt shipped.\nEnjoy.');
  assert.deepStrictEqual(full, { status: 'shipped', version: '0.4.2', updated: '2026-10-18T14:03:11.000Z', note: 'It shipped.\nEnjoy.' });
  const bare = core.parseStatusFile('status: seen');
  assert.deepStrictEqual(bare, { status: 'seen', version: '', updated: '', note: '' });
  const crlf = core.parseStatusFile('status: answered\r\n---\r\nThe answer is 42.');
  assert.strictEqual(crlf.status, 'answered');
  assert.strictEqual(crlf.note, 'The answer is 42.');
  assert.strictEqual(core.parseStatusFile('status: draft\n---\nx'), null, 'local-only states are not valid status files');
  assert.strictEqual(core.parseStatusFile('status: bogus'), null);
  assert.strictEqual(core.parseStatusFile(''), null);
  assert.strictEqual(core.statusLabel('shipped', { version: '0.4.2' }), 'Shipped in v0.4.2');
  assert.strictEqual(core.statusLabel('shipped', { version: 'v0.4.2' }), 'Shipped in v0.4.2');
  assert.strictEqual(core.statusLabel('sent', null), 'Sent to Muse');
  console.log('  ✓ core: status parsing (full/bare/CRLF), local-state rejection, labels');
}

// ---------- settings: GitHub token storage ----------
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-req-settings-'));
  const fakeSafe = {
    isEncryptionAvailable: () => true,
    encryptString: (s) => Buffer.from(`enc:${s}`, 'utf8'),
    decryptString: (b) => b.toString('utf8').replace(/^enc:/, '')
  };
  const store = createSettingsStore(dir, fakeSafe, dir);
  assert.strictEqual(store.getPublicSettings().hasGithubToken, false);
  store.save({ githubToken: FAKE_TOKEN });
  assert.strictEqual(store.getPublicSettings().hasGithubToken, true);
  assert.strictEqual(store.getGithubToken(), FAKE_TOKEN, 'token round-trips through encryption');
  const onDisk = fs.readFileSync(path.join(dir, 'settings.json'), 'utf8');
  assert.ok(!onDisk.includes(FAKE_TOKEN), 'settings.json must never hold the token in plaintext');
  store.clearGithubToken();
  assert.strictEqual(store.getPublicSettings().hasGithubToken, false);
  assert.strictEqual(store.getGithubToken(), null);

  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-req-settings2-'));
  const noSafe = createSettingsStore(dir2, null, dir2);
  noSafe.save({ githubToken: FAKE_TOKEN });
  assert.strictEqual(noSafe.getPublicSettings().hasGithubToken, true, 'session-only token still counts as set');
  assert.strictEqual(noSafe.getGithubToken(), FAKE_TOKEN, 'session-only token kept in memory');
  const onDisk2 = fs.readFileSync(path.join(dir2, 'settings.json'), 'utf8');
  assert.ok(!onDisk2.includes('encryptedGithubToken'), 'without OS encryption the token is never persisted');
  console.log('  ✓ settings: GitHub token encrypted at rest / session-only without encryption');
}

// ---------- fake GitHub ----------
function jsonResponse(status, obj) {
  return { ok: status >= 200 && status < 300, status, json: async () => obj, text: async () => JSON.stringify(obj) };
}

function makeFakeGitHub() {
  const files = new Map();
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    const method = opts.method || 'GET';
    calls.push({ url, method, headers: opts.headers || {}, body: opts.body ? JSON.parse(opts.body) : null });
    const m = new RegExp(`^https://api\\.github\\.com/repos/${OWNER}/${REPO}/contents/(.+)$`).exec(url);
    if (!m) return jsonResponse(404, { message: 'Not Found' });
    const p = decodeURIComponent(m[1]);
    if (method === 'GET' && p === 'requests') {
      const entries = new Map();
      for (const key of files.keys()) {
        const rest = key.slice('requests/'.length);
        const first = rest.split('/')[0];
        if (rest.includes('/')) entries.set(first, { name: first, path: `requests/${first}`, type: 'dir' });
        else entries.set(first, { name: first, path: key, type: 'file' });
      }
      return jsonResponse(200, [...entries.values()]);
    }
    if (method === 'GET') {
      if (!files.has(p)) return jsonResponse(404, { message: 'Not Found' });
      return jsonResponse(200, { encoding: 'base64', content: Buffer.from(files.get(p), 'utf8').toString('base64') });
    }
    if (method === 'PUT') {
      const body = JSON.parse(opts.body);
      files.set(p, Buffer.from(body.content, 'base64').toString('utf8'));
      return jsonResponse(201, { commit: { sha: `fake-sha-${files.size}` }, content: { path: p } });
    }
    return jsonResponse(405, { message: 'Method Not Allowed' });
  };
  return { files, calls, fetchImpl };
}

const FIXED_NOW = new Date('2026-10-18T09:15:00.000Z');

function makeChannel(dir, gh, getToken) {
  return createRequestsChannel({
    userDataPath: dir,
    getToken,
    hostname: 'TEST-PC',
    appVersion: '0.4.1',
    fetchImpl: gh.fetchImpl,
    now: () => FIXED_NOW
  });
}

(async () => {
  // ---------- channel: no token → honest draft ----------
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-req-draft-'));
    const gh = makeFakeGitHub();
    const channel = makeChannel(dir, gh, () => null);
    const res = await channel.compose({ type: 'feature', text: 'Add a dark-mode toggle please' });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.hasToken, false);
    assert.strictEqual(res.request.status, 'draft', 'no token → draft, never a fake send');
    assert.strictEqual(res.request.id, 'REQ-20261018-051500-add-a-dark-mode-toggle-please');
    assert.strictEqual(gh.calls.length, 0, 'no token → zero network calls');
    const list = channel.list();
    assert.strictEqual(list.items.length, 1);
    assert.strictEqual(list.items[0].canRetry, true);
    assert.strictEqual(list.items[0].statusLabel, 'Draft — not sent yet');
    const retry = await channel.retry(res.request.id);
    assert.strictEqual(retry.ok, false, 'retry without a token reports, not sends');
    assert.ok(retry.error.includes('GitHub token in Settings'));
    await assert.rejects(() => channel.compose({ type: 'task', text: '   ' }), /empty/);
    console.log('  ✓ channel: no-token draft fallback + honest retry refusal');
  }

  // ---------- channel: collision suffixing on the same second ----------
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-req-collide-'));
    const gh = makeFakeGitHub();
    const channel = makeChannel(dir, gh, () => null);
    const a = await channel.compose({ type: 'task', text: 'Same words' });
    const b = await channel.compose({ type: 'task', text: 'Same words' });
    assert.strictEqual(a.request.id, 'REQ-20261018-051500-same-words');
    assert.strictEqual(b.request.id, 'REQ-20261018-051500-same-words-2');
    console.log('  ✓ channel: same-second collision gets a -2 suffix');
  }

  // ---------- channel: send with token ----------
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-req-send-'));
    const gh = makeFakeGitHub();
    const channel = makeChannel(dir, gh, () => FAKE_TOKEN);
    const res = await channel.compose({ type: 'skill', text: 'Teach the app to sort my Downloads by sender' });
    assert.strictEqual(res.request.status, 'sent');
    const puts = gh.calls.filter((c) => c.method === 'PUT');
    assert.strictEqual(puts.length, 1, 'exactly one PUT');
    assert.ok(puts[0].url.endsWith(`/contents/requests/${res.request.id}.md`), 'PUT targets the request file path');
    assert.strictEqual(puts[0].headers.Authorization, `Bearer ${FAKE_TOKEN}`, 'token rides the Authorization header to GitHub only');
    const stored = gh.files.get(`requests/${res.request.id}.md`);
    const parsed = core.parseRequestFile(stored);
    assert.strictEqual(parsed.type, 'skill');
    assert.strictEqual(parsed.machine, 'TEST-PC');
    assert.strictEqual(parsed.text, 'Teach the app to sort my Downloads by sender', 'file body is verbatim');
    const list = channel.list();
    assert.strictEqual(list.items[0].status, 'sent');
    assert.strictEqual(list.hasToken, true);
    console.log('  ✓ channel: send with token (one scoped PUT, verbatim file)');
  }

  // ---------- channel: failure → send-failed; retry idempotency ----------
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-req-retry-'));
    const gh = makeFakeGitHub();
    let failMode = true;
    const flakyFetch = async (url, opts) => {
      if (failMode) throw new Error('network down');
      return gh.fetchImpl(url, opts);
    };
    const channel = createRequestsChannel({
      userDataPath: dir, getToken: () => FAKE_TOKEN, hostname: 'TEST-PC',
      appVersion: '0.4.1', fetchImpl: flakyFetch, now: () => FIXED_NOW
    });
    const res = await channel.compose({ type: 'task', text: 'Check my calendar for conflicts' });
    assert.strictEqual(res.request.status, 'send-failed');
    assert.ok(res.request.lastError.includes('unreachable'), 'failure keeps a plain-words error');

    // The PUT actually landed despite the lost response: seed the file,
    // then retry — it must see the file and NOT PUT again.
    const fileText = core.buildRequestFile({
      id: res.request.id, type: 'task', createdAt: res.request.createdAt,
      machine: 'TEST-PC', appVersion: '0.4.1', text: 'Check my calendar for conflicts'
    });
    gh.files.set(`requests/${res.request.id}.md`, fileText);
    failMode = false;
    const retry = await channel.retry(res.request.id);
    assert.strictEqual(retry.ok, true);
    assert.strictEqual(retry.request.status, 'sent');
    assert.strictEqual(gh.calls.filter((c) => c.method === 'PUT').length, 0, 'retry after a landed send performs NO duplicate PUT');

    // And a plain retry (file absent) sends exactly once.
    const res2 = await channel.compose({ type: 'question', text: 'What did Dot say about the last test?' });
    assert.strictEqual(res2.request.status, 'sent');
    assert.strictEqual(gh.calls.filter((c) => c.method === 'PUT').length, 1);
    console.log('  ✓ channel: send-failed draft, retry idempotent (no duplicates)');
  }

  // ---------- channel: refresh (discovery + statuses + offline cache) ----------
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-req-refresh-'));
    const gh = makeFakeGitHub();
    const channel = makeChannel(dir, gh, () => FAKE_TOKEN);
    const mine = await channel.compose({ type: 'feature', text: 'My own request from this PC' });
    // Another machine's request + Muse's status files arrive in the repo.
    const otherId = 'REQ-20261018-060000-other-machine-idea';
    gh.files.set(`requests/${otherId}.md`, core.buildRequestFile({
      id: otherId, type: 'question', createdAt: '2026-10-18T10:00:00.000Z',
      machine: 'OTHER-PC', appVersion: '0.4.1', text: 'Did the nightly summary run?'
    }));
    gh.files.set(`requests/${otherId}/status.md`, 'status: answered\nupdated: 2026-10-18T11:00:00.000Z\n---\nAnswered in your Muse chat.');
    gh.files.set(`requests/${mine.request.id}/status.md`, 'status: shipped\nversion: 0.4.2\nupdated: 2026-10-18T12:00:00.000Z\n---\nDone — see the release notes.');

    const view = await channel.refresh();
    assert.strictEqual(view.offline, false);
    assert.ok(view.checkedAt, 'refresh stamps checkedAt');
    assert.strictEqual(view.items.length, 2);
    const other = view.items.find((i) => i.id === otherId);
    assert.strictEqual(other.origin, 'remote');
    assert.strictEqual(other.status, 'answered');
    assert.strictEqual(other.statusNote, 'Answered in your Muse chat.');
    assert.strictEqual(other.title, 'Did the nightly summary run?');
    const mineView = view.items.find((i) => i.id === mine.request.id);
    assert.strictEqual(mineView.status, 'shipped');
    assert.strictEqual(mineView.statusLabel, 'Shipped in v0.4.2');
    assert.strictEqual(mineView.statusVersion, '0.4.2');

    // Offline refresh: the cache answers, flagged — never an error wall.
    const downChannel = createRequestsChannel({
      userDataPath: dir, getToken: () => FAKE_TOKEN, hostname: 'TEST-PC',
      appVersion: '0.4.1', fetchImpl: async () => { throw new Error('offline'); }, now: () => FIXED_NOW
    });
    const offlineView = await downChannel.refresh();
    assert.strictEqual(offlineView.offline, true);
    assert.strictEqual(offlineView.items.length, 2, 'offline still shows the cached requests');
    assert.strictEqual(offlineView.items.find((i) => i.id === otherId).status, 'answered', 'cached statuses survive offline');
    console.log('  ✓ channel: refresh discovers + statuses; offline returns cache');
  }

  // ---------- client scope: nothing outside requests/ ----------
  {
    const gh = makeFakeGitHub();
    const client = createGitHubClient({ token: FAKE_TOKEN, fetchImpl: gh.fetchImpl });
    await assert.rejects(() => client.getFileText('secrets/x.md'), /only touch requests\//);
    await assert.rejects(() => client.getFileText('requests/../README.md'), /only touch requests\//);
    await assert.rejects(() => client.putFileText('README.md', 'x', 'm'), /only touch requests\//);
    assert.strictEqual(gh.calls.length, 0, 'refused paths never reach the network');
    console.log('  ✓ client: refuses every path outside requests/');
  }

  // ---------- token redaction across every artifact ----------
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-req-redact-'));
    const gh = makeFakeGitHub();
    const channel = makeChannel(dir, gh, () => FAKE_TOKEN);
    const res = await channel.compose({ type: 'feature', text: 'Redaction check request' });
    gh.files.set(`requests/${res.request.id}/status.md`, 'status: building\n---\nWorking on it.');
    await channel.refresh();
    const artifacts = {
      'requests-local.json': fs.readFileSync(path.join(dir, 'requests-local.json'), 'utf8'),
      'list() JSON': JSON.stringify(channel.list()),
      'compose result JSON': JSON.stringify(res),
      'request file in repo': gh.files.get(`requests/${res.request.id}.md`),
      'PUT bodies': JSON.stringify(gh.calls.filter((c) => c.method === 'PUT').map((c) => c.body))
    };
    for (const [name, text] of Object.entries(artifacts)) {
      assert.ok(!String(text).includes(FAKE_TOKEN), `${name} MUST NOT contain the GitHub token`);
    }
    console.log('  ✓ redaction: token absent from local store, repo files, and return values');
  }

  console.log('requests.test.js: ALL PASS');
})().catch((err) => { console.error(err); process.exit(1); });
