'use strict';

// Auto-updater — Muse Bridge v0.3.3, spec section A.
//
// electron-updater against GitHub Releases of the PUBLIC repo
//   mikebestoption/muse-bridge-dots-public-release
// Public = no credentials in the app: there is no token, secret, or
// private-repo reference anywhere in this module. The feed is the
// public GitHub Releases feed for that owner/repo only.
//
// Design:
//   - The electron-updater instance is INJECTED (createUpdater takes
//     { autoUpdater, app, getWindow, log }), so this file never
//     requires 'electron' or 'electron-updater' itself. main.js wires
//     the real objects in; the unit tests wire plain fakes in, and the
//     whole module runs under bare node.
//   - Pure helpers (normalizeStatus, isPackagedGuard) carry all the
//     mapping / gating logic and are tested without any fake at all.
//   - Status is forwarded to the renderer on one channel,
//     'updater:status', always as { state, info } with state one of:
//       checking | available | not-available | downloading |
//       downloaded | error
//     'downloading' info carries a numeric `percent` (0-100).
//   - Install is gated: requestInstall() refuses until an
//     'update-downloaded' event has actually arrived, then calls
//     quitAndInstall(false, true) — not silent, run after install.
//     autoInstallOnAppQuit stays false so quitting the app never
//     installs behind the user's back; the only path to install is
//     the user accepting the "Restart to update" prompt, which calls
//     requestInstall().

const GITHUB_OWNER = 'mikebestoption';
const GITHUB_REPO = 'muse-bridge-dots-public-release';
const STATUS_CHANNEL = 'updater:status';

// The exact feed config handed to setFeedURL. Frozen so a caller
// cannot mutate the shared object between factory calls.
const FEED_CONFIG = Object.freeze({
  provider: 'github',
  owner: GITHUB_OWNER,
  repo: GITHUB_REPO
});

// ------------------------------------------------------------------
// Pure helpers
// ------------------------------------------------------------------

// isPackagedGuard(appLike) -> boolean
// True when update checks are allowed to run. Reads `app.isPackaged`
// only when it is actually provided:
//   - no app at all            -> true  (no guard information; the
//                                        task spec says guard "with
//                                        app.isPackaged if provided")
//   - isPackaged not provided  -> true  (same reason)
//   - isPackaged === boolean   -> that boolean
//   - isPackaged is a function -> its boolean return (defensive; the
//                                 real Electron property is a boolean)
// Anything unreadable falls back to true rather than throwing — the
// check itself will then fail honestly in checkNow/checkOnLaunch if
// the updater is genuinely unusable.
function isPackagedGuard(appLike) {
  if (!appLike) return true;
  const value = appLike.isPackaged;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'function') {
    try {
      return Boolean(value.call(appLike));
    } catch (_) {
      return true;
    }
  }
  return true;
}

function errorMessage(payload) {
  if (!payload) return 'Unknown updater error.';
  if (payload instanceof Error) return payload.message || String(payload);
  if (typeof payload === 'string') return payload;
  if (typeof payload.message === 'string' && payload.message) return payload.message;
  try {
    return String(payload);
  } catch (_) {
    return 'Unknown updater error.';
  }
}

function clampPercent(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 100) return 100;
  return n;
}

// normalizeStatus(event, payload) -> { state, info }
// Pure mapping from an electron-updater event name + payload to the
// renderer-facing status shape. Never throws, never invents success:
// unknown events become an honest 'error' status.
function normalizeStatus(event, payload) {
  switch (event) {
    case 'checking-for-update':
    case 'checking':
      return { state: 'checking', info: payload && typeof payload === 'object' ? { ...payload } : {} };

    case 'update-available':
    case 'available':
      return { state: 'available', info: payload && typeof payload === 'object' ? { ...payload } : {} };

    case 'update-not-available':
    case 'not-available':
      return { state: 'not-available', info: payload && typeof payload === 'object' ? { ...payload } : {} };

    case 'download-progress':
    case 'downloading': {
      const src = payload && typeof payload === 'object' ? payload : {};
      return {
        state: 'downloading',
        info: { ...src, percent: clampPercent(src.percent) }
      };
    }

    case 'update-downloaded':
    case 'downloaded':
      return { state: 'downloaded', info: payload && typeof payload === 'object' ? { ...payload } : {} };

    case 'error':
      return { state: 'error', info: { message: errorMessage(payload) } };

    default:
      return {
        state: 'error',
        info: { message: `Unknown updater event: ${String(event)}` }
      };
  }
}

// ------------------------------------------------------------------
// Factory
// ------------------------------------------------------------------

// createUpdater({ autoUpdater, app, getWindow, log })
//   autoUpdater: an electron-updater autoUpdater (or a fake of one)
//   app:         Electron app (only .isPackaged is read), optional
//   getWindow:   () => BrowserWindow | null, optional — status is
//                dropped quietly when there is no window to send to
//   log:         a function (message) => void, or an object with
//                info/warn/error/log methods, optional
//
// Returns { checkOnLaunch, checkNow, requestInstall, promptRestart,
//           isDownloaded, getLastStatus, feedConfig }.
// promptRestart is an alias of requestInstall: it is the action the
// "Restart to update" prompt invokes.
function createUpdater({ autoUpdater, app, getWindow, log } = {}) {
  let downloadComplete = false;
  let lastStatus = null;

  function writeLog(message) {
    try {
      if (typeof log === 'function') log(message);
      else if (log && typeof log.info === 'function') log.info(message);
      else if (log && typeof log.log === 'function') log.log(message);
    } catch (_) {
      // Logging must never break the updater.
    }
  }

  function writeErrorLog(message) {
    try {
      if (log && typeof log.error === 'function') log.error(message);
      else writeLog(message);
    } catch (_) {
      // Logging must never break the updater.
    }
  }

  function resolveWindow() {
    if (!getWindow) return null;
    try {
      // Primary contract: getWindow is a function returning a window.
      if (typeof getWindow === 'function') return getWindow() || null;
      // Tolerated: a window object passed directly.
      return getWindow;
    } catch (_) {
      return null;
    }
  }

  function sendStatus(status) {
    lastStatus = status;
    const win = resolveWindow();
    if (!win || !win.webContents || typeof win.webContents.send !== 'function') {
      return false;
    }
    try {
      win.webContents.send(STATUS_CHANNEL, status);
      return true;
    } catch (err) {
      writeErrorLog(`updater: failed to forward status to renderer: ${errorMessage(err)}`);
      return false;
    }
  }

  function emit(event, payload) {
    const status = normalizeStatus(event, payload);
    if (status.state === 'downloaded') downloadComplete = true;
    if (status.state === 'checking' || status.state === 'available') {
      // A fresh check / a fresh download supersedes any earlier
      // completed download — requestInstall must not install a
      // stale build after a new cycle has started.
      if (status.state === 'checking') downloadComplete = false;
    }
    if (status.state === 'error') {
      writeErrorLog(`updater: ${status.info.message}`);
    }
    sendStatus(status);
    return status;
  }

  // ---- configure the injected updater ----
  if (autoUpdater) {
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = false;

    if (typeof autoUpdater.setFeedURL === 'function') {
      autoUpdater.setFeedURL({ ...FEED_CONFIG });
    } else {
      writeErrorLog('updater: autoUpdater.setFeedURL is not available; update feed was not configured.');
    }

    if (typeof autoUpdater.on === 'function') {
      autoUpdater.on('checking-for-update', () => emit('checking-for-update'));
      autoUpdater.on('update-available', (info) => emit('update-available', info));
      autoUpdater.on('update-not-available', (info) => emit('update-not-available', info));
      autoUpdater.on('download-progress', (progress) => emit('download-progress', progress));
      autoUpdater.on('update-downloaded', (info) => emit('update-downloaded', info));
      autoUpdater.on('error', (err) => emit('error', err));
    } else {
      writeErrorLog('updater: autoUpdater does not support event subscription; status updates will not be forwarded.');
    }
  }

  function runCheck(manual) {
    if (!autoUpdater || typeof autoUpdater.checkForUpdates !== 'function') {
      const message = 'Update check is unavailable: the updater is not configured.';
      emit('error', new Error(message));
      return { checked: false, reason: 'not-configured' };
    }
    if (!isPackagedGuard(app)) {
      const message = 'Update checks are disabled in development (the app is not packaged).';
      if (manual) {
        // A user who explicitly clicked "Check for updates" deserves
        // a visible, honest answer — not silence.
        emit('error', new Error(message));
      } else {
        writeLog(`updater: ${message}`);
      }
      return { checked: false, reason: 'not-packaged' };
    }
    try {
      const result = autoUpdater.checkForUpdates();
      // electron-updater returns a promise that can reject (no
      // network, bad release feed, ...). Surface that as an error
      // status instead of an unhandled rejection.
      if (result && typeof result.catch === 'function') {
        result.catch((err) => emit('error', err));
      }
      return { checked: true, result };
    } catch (err) {
      emit('error', err);
      return { checked: false, reason: 'check-failed' };
    }
  }

  // Check on launch: a no-op in dev / when the app is not packaged.
  function checkOnLaunch() {
    return runCheck(false);
  }

  // Manual "Check for updates" from Settings.
  function checkNow() {
    return runCheck(true);
  }

  // The prompt-restart flow: only a completed download may install.
  function requestInstall() {
    if (!downloadComplete) {
      writeLog('updater: install requested but no update has finished downloading; refusing.');
      return false;
    }
    if (!autoUpdater || typeof autoUpdater.quitAndInstall !== 'function') {
      writeErrorLog('updater: install requested but quitAndInstall is not available.');
      return false;
    }
    autoUpdater.quitAndInstall(false, true);
    return true;
  }

  return {
    checkOnLaunch,
    checkNow,
    requestInstall,
    promptRestart: requestInstall,
    isDownloaded: () => downloadComplete,
    getLastStatus: () => lastStatus,
    feedConfig: { ...FEED_CONFIG }
  };
}

module.exports = {
  createUpdater,
  normalizeStatus,
  isPackagedGuard,
  GITHUB_OWNER,
  GITHUB_REPO,
  FEED_CONFIG,
  STATUS_CHANNEL
};
