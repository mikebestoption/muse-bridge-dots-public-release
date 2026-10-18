'use strict';

// Session guard checks — the "never fight the user" layer.
// Run: node tests/sessionGuard.test.js
// The decision function is pure and the runner takes injected probes, so
// the full matrix runs here with no Windows and no real input devices.

const assert = require('assert');
const {
  HANDS_ACTIONS,
  INTERACTIVE_IDLE_SEC,
  isHandsAction,
  normalizeGuardSettings,
  decide,
  runGuard,
  parkMessage
} = require('../src/sessionGuard');

const S = { handsIdleThresholdSeconds: 30, handsMaxWaitMinutes: 30 }; // shipped defaults

let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
  console.log('  ✓', name);
}
async function checkAsync(name, fn) {
  await fn();
  passed += 1;
  console.log('  ✓', name);
}

(async () => {
  // ---- which actions are "hands" ----
  check('hands actions are exactly the four typing actions', () => {
    assert.deepStrictEqual(
      [...HANDS_ACTIONS].sort(),
      ['copy_from_app', 'fill_login', 'fill_totp', 'paste_to_app']
    );
    assert.ok(isHandsAction('fill_login'));
    assert.ok(isHandsAction('paste_to_app'));
    assert.ok(!isHandsAction('run_command'), 'shell is a brain action in this model');
    assert.ok(!isHandsAction('list_folder'));
    assert.ok(!isHandsAction('open_url'));
  });

  check('settings normalization: defaults + overrides', () => {
    assert.deepStrictEqual(normalizeGuardSettings({}), {
      idleThresholdSec: 30, maxWaitMin: 30, interactiveIdleSec: INTERACTIVE_IDLE_SEC
    });
    assert.deepStrictEqual(normalizeGuardSettings({ handsIdleThresholdSeconds: 45, handsMaxWaitMinutes: 5 }), {
      idleThresholdSec: 45, maxWaitMin: 5, interactiveIdleSec: INTERACTIVE_IDLE_SEC
    });
    assert.strictEqual(normalizeGuardSettings({ handsIdleThresholdSeconds: -1 }).idleThresholdSec, 30);
    assert.strictEqual(normalizeGuardSettings(null).maxWaitMin, 30);
  });

  // ---- decide(): queue mode ----
  check('queue: recent activity → WAIT (user-active)', () => {
    const d = decide({ platform: 'win32', idleMs: 4000, desktopTypable: true, mode: 'queue', waitedMs: 0, settings: S });
    assert.strictEqual(d.decision, 'WAIT');
    assert.strictEqual(d.kind, 'user-active');
    assert.strictEqual(d.remainingMs, 26000);
  });

  check('queue: idle past threshold → PROCEED', () => {
    const d = decide({ platform: 'win32', idleMs: 30000, desktopTypable: true, mode: 'queue', waitedMs: 9000, settings: S });
    assert.strictEqual(d.decision, 'PROCEED');
  });

  check('queue: locked session → PARK (session), even with huge idle', () => {
    const d = decide({ platform: 'win32', idleMs: 3600000, desktopTypable: false, mode: 'queue', waitedMs: 0, settings: S });
    assert.strictEqual(d.decision, 'PARK');
    assert.strictEqual(d.reason, 'session');
  });

  check('queue: switched-away session (desktop unopenable) → PARK (session)', () => {
    // Probe encodes "cannot open input desktop" as desktopTypable === false.
    const d = decide({ platform: 'win32', idleMs: null, desktopTypable: false, mode: 'queue', waitedMs: 0, settings: S });
    assert.strictEqual(d.decision, 'PARK');
    assert.strictEqual(d.reason, 'session');
  });

  check('queue: still active after max wait → PARK (user-active)', () => {
    const d = decide({ platform: 'win32', idleMs: 1000, desktopTypable: true, mode: 'queue', waitedMs: 30 * 60 * 1000, settings: S });
    assert.strictEqual(d.decision, 'PARK');
    assert.strictEqual(d.reason, 'user-active');
  });

  check('queue: idle reached exactly as wait expires → PROCEED wins', () => {
    const d = decide({ platform: 'win32', idleMs: 45000, desktopTypable: true, mode: 'queue', waitedMs: 30 * 60 * 1000, settings: S });
    assert.strictEqual(d.decision, 'PROCEED');
  });

  check('queue: unknown idle on Windows → WAIT (fail safe, never type blind)', () => {
    const d = decide({ platform: 'win32', idleMs: null, desktopTypable: null, mode: 'queue', waitedMs: 0, settings: S });
    assert.strictEqual(d.decision, 'WAIT');
  });

  // ---- decide(): interactive mode (countdown semantics) ----
  check('interactive: just clicked Approve (idle ≈ 0) → WAIT with full countdown', () => {
    const d = decide({ platform: 'win32', idleMs: 120, desktopTypable: true, mode: 'interactive', waitedMs: 0, settings: S });
    assert.strictEqual(d.decision, 'WAIT');
    assert.strictEqual(d.kind, 'countdown');
    assert.ok(d.remainingMs > 2500 && d.remainingMs <= 3000, `remaining ${d.remainingMs}`);
  });

  check('interactive: countdown shrinks as idle grows', () => {
    const d = decide({ platform: 'win32', idleMs: 2000, desktopTypable: true, mode: 'interactive', waitedMs: 2000, settings: S });
    assert.strictEqual(d.decision, 'WAIT');
    assert.strictEqual(d.remainingMs, 1000);
  });

  check('interactive: user typing resets the countdown (idle drops → remaining grows back)', () => {
    const before = decide({ platform: 'win32', idleMs: 2500, desktopTypable: true, mode: 'interactive', waitedMs: 2500, settings: S });
    const afterType = decide({ platform: 'win32', idleMs: 80, desktopTypable: true, mode: 'interactive', waitedMs: 2600, settings: S });
    assert.strictEqual(before.remainingMs, 500);
    assert.ok(afterType.remainingMs > 2900, `countdown reset, remaining ${afterType.remainingMs}`);
  });

  check('interactive: 3 s continuous idle → PROCEED', () => {
    const d = decide({ platform: 'win32', idleMs: 3000, desktopTypable: true, mode: 'interactive', waitedMs: 3000, settings: S });
    assert.strictEqual(d.decision, 'PROCEED');
  });

  check('interactive: locked at approval time → PARK (session), not an error', () => {
    const d = decide({ platform: 'win32', idleMs: 0, desktopTypable: false, mode: 'interactive', waitedMs: 0, settings: S });
    assert.strictEqual(d.decision, 'PARK');
    assert.strictEqual(d.reason, 'session');
  });

  check('cancelled beats everything', () => {
    const d = decide({ platform: 'win32', idleMs: 99999, desktopTypable: true, mode: 'queue', waitedMs: 0, cancelled: true, settings: S });
    assert.strictEqual(d.decision, 'CANCELLED');
    const d2 = decide({ platform: 'linux', idleMs: null, desktopTypable: null, mode: 'queue', waitedMs: 0, cancelled: true, settings: S });
    assert.strictEqual(d2.decision, 'CANCELLED');
  });

  // ---- decide(): non-Windows passthrough ----
  check('non-Windows: unknown probes → PROCEED (behavior as before the guard)', () => {
    for (const mode of ['queue', 'interactive']) {
      const d = decide({ platform: 'linux', idleMs: null, desktopTypable: null, mode, waitedMs: 0, settings: S });
      assert.strictEqual(d.decision, 'PROCEED');
    }
    const d = decide({ platform: 'darwin', idleMs: 0, desktopTypable: false, mode: 'queue', waitedMs: 0, settings: S });
    assert.strictEqual(d.decision, 'PROCEED', 'even a "locked" reading is ignored off-Windows');
  });

  check('park messages name the cause and say nothing was typed', () => {
    assert.ok(parkMessage('session').includes('locked or switched'));
    assert.ok(parkMessage('session').includes('nothing was typed'));
    assert.ok(parkMessage('user-active').includes('still using the PC'));
  });

  // ---- runGuard(): full loop with injected fakes ----
  // Fake clock: sleep(ms) advances time; idle is modeled as time since the
  // last scripted "user activity" instant.
  function fakeWorld({ activityUntil = 0, typable = true } = {}) {
    let t = 0;
    let lastActivity = 0;
    return {
      now: () => t,
      sleep: async (ms) => { t += ms; },
      probe: async () => {
        if (t < activityUntil) lastActivity = t; // user keeps touching input
        return { idleMs: t - lastActivity, desktopTypable: typable };
      },
      time: () => t
    };
  }

  await checkAsync('runner/queue: waits out activity, proceeds once idle ≥ threshold', async () => {
    // User active for the first 10 s, then walks away. Threshold 5 s.
    const w = fakeWorld({ activityUntil: 10000 });
    const statuses = [];
    const res = await runGuard({
      probe: w.probe, mode: 'queue', platform: 'win32',
      settings: { handsIdleThresholdSeconds: 5, handsMaxWaitMinutes: 10 },
      sleep: w.sleep, now: w.now, pollMs: 1000,
      onStatus: (s) => statuses.push(s)
    });
    assert.strictEqual(res.decision, 'PROCEED');
    assert.ok(w.time() >= 14000, `proceeded at ${w.time()} (activity till ~10 s + 5 s idle threshold)`);
    assert.ok(statuses.length >= 1 && statuses[0].kind === 'user-active', 'wait status was reported');
  });

  await checkAsync('runner/queue: user never stops → PARK user-active at max wait', async () => {
    const w = fakeWorld({ activityUntil: Infinity });
    const res = await runGuard({
      probe: w.probe, mode: 'queue', platform: 'win32',
      settings: { handsIdleThresholdSeconds: 5, handsMaxWaitMinutes: 0.2 }, // 12 s
      sleep: w.sleep, now: w.now, pollMs: 1000
    });
    assert.strictEqual(res.decision, 'PARK');
    assert.strictEqual(res.reason, 'user-active');
    assert.ok(res.waitedMs >= 12000);
  });

  await checkAsync('runner/queue: locked from the start → PARK session immediately', async () => {
    const w = fakeWorld({ typable: false });
    const res = await runGuard({
      probe: w.probe, mode: 'queue', platform: 'win32',
      settings: S, sleep: w.sleep, now: w.now, pollMs: 1000
    });
    assert.strictEqual(res.decision, 'PARK');
    assert.strictEqual(res.reason, 'session');
    assert.strictEqual(w.time(), 0, 'no waiting happened');
  });

  await checkAsync('runner/interactive: countdown completes after 3 s idle', async () => {
    const w = fakeWorld({ activityUntil: 0 });
    const seen = [];
    const res = await runGuard({
      probe: w.probe, mode: 'interactive', platform: 'win32',
      settings: S, sleep: w.sleep, now: w.now, pollMs: 500,
      onStatus: (s) => seen.push(s.remainingSec)
    });
    assert.strictEqual(res.decision, 'PROCEED');
    assert.ok(seen.includes(3) || seen.includes(2), `countdown values seen: ${seen}`);
  });

  await checkAsync('runner/interactive: Stop cancels the wait', async () => {
    const w = fakeWorld({ activityUntil: Infinity });
    let polls = 0;
    const res = await runGuard({
      probe: async () => { polls += 1; return w.probe(); },
      mode: 'interactive', platform: 'win32',
      settings: S, sleep: w.sleep, now: w.now, pollMs: 500,
      isCancelled: () => polls >= 3
    });
    assert.strictEqual(res.decision, 'CANCELLED');
  });

  await checkAsync('runner: session locks mid-wait → PARK session', async () => {
    let t = 0;
    const res = await runGuard({
      probe: async () => ({ idleMs: 0, desktopTypable: t < 5000 }),
      mode: 'queue', platform: 'win32',
      settings: { handsIdleThresholdSeconds: 30, handsMaxWaitMinutes: 10 },
      sleep: async (ms) => { t += ms; }, now: () => t, pollMs: 1000
    });
    assert.strictEqual(res.decision, 'PARK');
    assert.strictEqual(res.reason, 'session');
    assert.strictEqual(t, 5000);
  });

  await checkAsync('runner: probe that throws is an unknown reading, not a crash', async () => {
    const res = await runGuard({
      probe: async () => { throw new Error('powershell missing'); },
      mode: 'queue', platform: 'linux', // non-Windows: unknown → proceed
      settings: S, sleep: async () => {}, now: Date.now
    });
    assert.strictEqual(res.decision, 'PROCEED');
  });

  console.log(`\nSESSION GUARD: ALL ${passed} CHECKS PASS`);
})().catch((err) => {
  console.error('\nSESSION GUARD FAIL:', err.message);
  process.exit(1);
});
