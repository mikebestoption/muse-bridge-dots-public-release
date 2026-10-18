'use strict';

// Session guard — the "never fight the user" layer for HANDS actions.
//
// HANDS actions are the ones that physically type into a window:
//   paste_to_app, copy_from_app, fill_login, fill_totp
// (copy_from_app types Ctrl+A/Ctrl+C into a focused window, so it counts.)
// Everything else — chat, file tasks, Bridge/GitHub work, shell jobs — is a
// BRAIN action and is NEVER guarded: brain work runs fine while the screen
// is locked or the session is switched to another user.
//
// The guard answers one question before any keystroke: "is it safe to type
// right now?" It never grants itself extra scope: if typing isn't safe, the
// step WAITS or PARKS (waiting_on_user) — it is never forced through.
//
// Two Windows probes, both in ONE fixed PowerShell script (no user data is
// interpolated into it — it reads only OS state):
//   1. Idle time: GetLastInputInfo — ms since the last mouse/keyboard input.
//   2. Input desktop: OpenInputDesktop + GetUserObjectInformation(UOI_NAME).
//      The interactive input desktop is named "Default". When the session is
//      locked, the input desktop is "Winlogon" (not typable). When the
//      session is switched away / disconnected (fast user switching), a
//      process in this session cannot open the input desktop at all
//      (OpenInputDesktop returns NULL) — also not typable. This probe was
//      chosen over checking for a LogonUI process because it answers the
//      actual question ("can THIS process type into the visible desktop?")
//      for both the locked and the switched-away case in one call.
//
// If the probe script itself hard-fails, the reading is "unknown"
// (desktopTypable: null) and the guard treats it as typable — the same
// documented fallback as non-Windows platforms. A probe failure must not
// brick the feature; the typing scripts themselves still fail honestly if
// the target window can't be focused.
//
// Decision logic is a PURE function (decide) — probes are injected, so the
// full matrix is unit-tested without Windows.

const { execFile } = require('child_process');

const HANDS_ACTIONS = ['paste_to_app', 'copy_from_app', 'fill_login', 'fill_totp'];

// Interactive approvals wait for ~3 s of continuous idle before typing, so a
// user who just clicked Approve (a mouse action — itself "input") gets a
// visible countdown window to pull their hands back or hit Stop.
const INTERACTIVE_IDLE_SEC = 3;

function isHandsAction(type) {
  return HANDS_ACTIONS.includes(type);
}

// Settings arrive from the settings store (seconds/minutes as the user sees
// them in Settings). Missing/invalid values fall back to the defaults:
// idle threshold 30 s, max wait 30 min. Fractional minutes are accepted
// (used by tests); the store rounds what the user types.
function normalizeGuardSettings(settings) {
  const s = settings || {};
  const idleThresholdSec =
    Number.isFinite(s.handsIdleThresholdSeconds) && s.handsIdleThresholdSeconds > 0
      ? s.handsIdleThresholdSeconds
      : 30;
  const maxWaitMin =
    Number.isFinite(s.handsMaxWaitMinutes) && s.handsMaxWaitMinutes > 0
      ? s.handsMaxWaitMinutes
      : 30;
  const interactiveIdleSec =
    Number.isFinite(s.handsInteractiveIdleSeconds) && s.handsInteractiveIdleSeconds > 0
      ? s.handsInteractiveIdleSeconds
      : INTERACTIVE_IDLE_SEC;
  return { idleThresholdSec, maxWaitMin, interactiveIdleSec };
}

// PURE decision function.
// Input: {
//   platform,                 // process.platform ('win32' | other)
//   idleMs,                   // ms since last user input, or null if unknown
//   desktopTypable,           // true | false | null (null = probe unknown)
//   mode,                     // 'interactive' | 'queue'
//   waitedMs,                 // how long the guard has already waited
//   cancelled,                // user pressed Stop/Deny during the wait
//   settings                  // raw settings (normalized inside)
// }
// Output: { decision: 'PROCEED' | 'WAIT' | 'PARK' | 'CANCELLED',
//           reason?: 'session' | 'user-active',
//           kind?: 'countdown' | 'user-active',   // for status display
//           remainingMs?: number }                // on WAIT
function decide(input) {
  const {
    platform,
    idleMs,
    desktopTypable,
    mode,
    waitedMs = 0,
    cancelled = false,
    settings
  } = input || {};
  const s = normalizeGuardSettings(settings);

  if (cancelled) return { decision: 'CANCELLED', reason: 'user' };

  // Non-Windows: probes are unknown → treat as typable, exactly as before
  // this guard existed (mock/Linux verification runs on this path).
  if (platform !== 'win32') return { decision: 'PROCEED' };

  // Locked (Winlogon desktop) or switched away / disconnected (input
  // desktop cannot be opened): do not type, do not fail — PARK. This check
  // comes before any idle math: a locked session can look "idle" forever.
  if (desktopTypable === false) return { decision: 'PARK', reason: 'session' };

  const maxWaitMs = s.maxWaitMin * 60 * 1000;

  if (mode === 'queue') {
    const needMs = s.idleThresholdSec * 1000;
    if (Number.isFinite(idleMs) && idleMs >= needMs) return { decision: 'PROCEED' };
    if (waitedMs >= maxWaitMs) return { decision: 'PARK', reason: 'user-active' };
    // idleMs unknown on Windows → assume the user might be active (fail
    // safe: keep waiting rather than typing blind).
    const assumedIdle = Number.isFinite(idleMs) ? idleMs : 0;
    return {
      decision: 'WAIT',
      kind: 'user-active',
      remainingMs: Math.max(0, needMs - assumedIdle)
    };
  }

  // Interactive: countdown semantics. idleMs IS the continuous-idle clock —
  // if the user starts typing, idleMs drops toward 0 and the remaining
  // countdown grows back to full. Nothing to reset explicitly.
  const needMs = s.interactiveIdleSec * 1000;
  if (Number.isFinite(idleMs) && idleMs >= needMs) return { decision: 'PROCEED' };
  if (waitedMs >= maxWaitMs) return { decision: 'PARK', reason: 'user-active' };
  const assumedIdle = Number.isFinite(idleMs) ? idleMs : 0;
  return {
    decision: 'WAIT',
    kind: 'countdown',
    remainingMs: Math.max(0, needMs - assumedIdle)
  };
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Guard runner: polls the injected probe until decide() says stop waiting.
// All side effects (probe, sleep, clock, cancel flag, status callback) are
// injected, so tests drive the full loop with fakes — no Windows needed.
//
// opts: {
//   probe,          // async () => { idleMs, desktopTypable }
//   mode,           // 'interactive' | 'queue'
//   settings,       // raw settings object
//   platform,       // default process.platform
//   isCancelled,    // () => boolean
//   onStatus,       // (status) => void — fired when the WAIT display changes
//   sleep, now,     // injectable for tests
//   pollMs          // default: 400 interactive / 5000 queue
// }
// Resolves with the final decide() output plus waitedMs.
async function runGuard(opts) {
  const {
    probe,
    mode = 'interactive',
    settings,
    platform = process.platform,
    isCancelled,
    onStatus,
    sleep = defaultSleep,
    now = Date.now,
    pollMs = mode === 'queue' ? 5000 : 400
  } = opts || {};

  const startedAt = now();
  let lastStatusKey = '';

  for (;;) {
    let snap = { idleMs: null, desktopTypable: null };
    if (probe) {
      try {
        snap = (await probe()) || snap;
      } catch (_) {
        // A probe error is an "unknown" reading, not a stop.
        snap = { idleMs: null, desktopTypable: null };
      }
    }
    const waitedMs = now() - startedAt;
    const d = decide({
      platform,
      idleMs: snap.idleMs,
      desktopTypable: snap.desktopTypable,
      mode,
      waitedMs,
      cancelled: Boolean(isCancelled && isCancelled()),
      settings
    });

    if (d.decision !== 'WAIT') {
      return { ...d, waitedMs };
    }

    // Status display: fire only when what the user would see changes
    // (countdown second, or entering the wait).
    const status = {
      state: 'waiting',
      kind: d.kind,
      mode,
      remainingMs: d.remainingMs,
      remainingSec: Math.max(1, Math.ceil(d.remainingMs / 1000)),
      waitedMs
    };
    const key = `${status.kind}:${status.remainingSec}`;
    if (onStatus && key !== lastStatusKey) {
      lastStatusKey = key;
      try { onStatus(status); } catch (_) { /* display must never break the guard */ }
    }

    await sleep(pollMs);
  }
}

// ---- Windows probes (main process only) ----
// FIXED script: reads only OS state. Add-Type compiles a tiny P/Invoke
// helper; GetLastInputInfo gives idle time, OpenInputDesktop +
// GetUserObjectInformation(2 = UOI_NAME) gives the input desktop's name.
const PS_HANDS_PROBE_SCRIPT = [
  'Add-Type -TypeDefinition @"',
  'using System;',
  'using System.Runtime.InteropServices;',
  'using System.Text;',
  'public static class HandsProbe {',
  '  [StructLayout(LayoutKind.Sequential)] public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }',
  '  [DllImport("user32.dll")] public static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);',
  '  [DllImport("kernel32.dll")] public static extern uint GetTickCount();',
  '  [DllImport("user32.dll", SetLastError = true)] public static extern IntPtr OpenInputDesktop(uint dwFlags, bool fInherit, uint dwDesiredAccess);',
  '  [DllImport("user32.dll", SetLastError = true)] public static extern bool GetUserObjectInformation(IntPtr hObj, int nIndex, StringBuilder pvInfo, uint nLength, out uint lpnLengthNeeded);',
  '  [DllImport("user32.dll")] public static extern bool CloseDesktop(IntPtr hDesktop);',
  '  public static long IdleMs() {',
  '    LASTINPUTINFO lii = new LASTINPUTINFO();',
  '    lii.cbSize = (uint)Marshal.SizeOf(lii);',
  '    if (!GetLastInputInfo(ref lii)) return -1;',
  '    return (long)(GetTickCount() - lii.dwTime);',
  '  }',
  '  public static string InputDesktopName() {',
  '    IntPtr h = OpenInputDesktop(0, false, 0x0001);',
  '    if (h == IntPtr.Zero) return null;',
  '    StringBuilder sb = new StringBuilder(256);',
  '    uint needed;',
  '    bool ok = GetUserObjectInformation(h, 2, sb, 256, out needed);',
  '    CloseDesktop(h);',
  '    return ok ? sb.ToString() : null;',
  '  }',
  '}',
  '"@',
  '$idle = [HandsProbe]::IdleMs()',
  '$name = [HandsProbe]::InputDesktopName()',
  '[Console]::Out.Write((@{ idleMs = $idle; desktop = $name } | ConvertTo-Json -Compress))'
].join('\n');

function createWindowsProbe() {
  return function probe() {
    return new Promise((resolve) => {
      execFile(
        'powershell.exe',
        ['-NoProfile', '-Command', PS_HANDS_PROBE_SCRIPT],
        { timeout: 10000, windowsHide: true },
        (err, stdout) => {
          if (err) {
            // Hard probe failure = unknown reading (documented fallback).
            resolve({ idleMs: null, desktopTypable: null });
            return;
          }
          try {
            const parsed = JSON.parse(String(stdout).trim());
            const idleMs =
              Number.isFinite(parsed.idleMs) && parsed.idleMs >= 0 ? parsed.idleMs : null;
            // Name "Default" → the user is looking at the interactive
            // desktop. Any other name (Winlogon…) or NULL (could not open —
            // switched away / disconnected) → not typable.
            const desktopTypable =
              parsed.desktop == null ? false : String(parsed.desktop) === 'Default';
            resolve({ idleMs, desktopTypable });
          } catch (_) {
            resolve({ idleMs: null, desktopTypable: null });
          }
        }
      );
    });
  };
}

// Non-Windows probe: everything is "unknown", and decide() treats
// non-Windows as typable — behavior exactly as before the guard existed.
function createPassthroughProbe() {
  return async () => ({ idleMs: null, desktopTypable: null });
}

function defaultProbe(platform) {
  return platform === 'win32' ? createWindowsProbe() : createPassthroughProbe();
}

// Human-readable parked message for a PARK decision. The Night Queue uses
// short fixed reasons ("session locked or switched away" / "user active on
// the PC"); this is the full sentence shown on cards and in results.
function parkMessage(reason) {
  if (reason === 'session') {
    return (
      '⏸ Parked — your Windows session is locked or switched to another user, ' +
      'so nothing was typed. Switch back / unlock, then run this step again.'
    );
  }
  return (
    '⏸ Parked — you were still using the PC when the wait ran out, ' +
    'so nothing was typed. Run this step again when the PC is free.'
  );
}

module.exports = {
  HANDS_ACTIONS,
  INTERACTIVE_IDLE_SEC,
  isHandsAction,
  normalizeGuardSettings,
  decide,
  runGuard,
  createWindowsProbe,
  createPassthroughProbe,
  defaultProbe,
  parkMessage,
  PS_HANDS_PROBE_SCRIPT
};
