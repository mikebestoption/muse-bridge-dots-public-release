'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell, safeStorage, clipboard } = require('electron');
const fs = require('fs');
const path = require('path');

const { createSettingsStore } = require('./src/settingsStore');
const { chatCompletion } = require('./src/sparkClient');
const { mockReply } = require('./src/mockBrain');
const { executeAction, describeAction } = require('./src/taskEngine');
const { resolveActionPaths } = require('./src/pathResolver');
const bridge = require('./src/bridge');
const dotTests = require('./src/dotTests');
const nightQueue = require('./src/nightQueue');
const audit = require('./src/audit');
const { Vault } = require('./src/vault');
const { totp } = require('./src/totp');
const sessionGuard = require('./src/sessionGuard');
const { createLessonsStore } = require('./src/lessons');
const { createUpdater } = require('./src/updater');

let settings = null;
let mainWindow = null;
let vault = null;
let lessons = null;
let updater = null;

// electron-updater is required lazily: it is only meaningful in a
// packaged build, and a dev/bare-node load of main's module graph must
// not fail on it. In dev, updater stays null and checks answer honestly.
function loadAutoUpdater() {
  try {
    return require('electron-updater').autoUpdater;
  } catch (_) {
    return null;
  }
}

// Probes for the hands guard (Windows: idle time + input desktop; other
// platforms: unknown → typable, as before the guard existed).
const guardProbe = sessionGuard.defaultProbe(process.platform);
// execId -> { cancelled } for in-flight guarded executions (Stop button).
const executions = new Map();

// The only bridge between the task engine and vault secrets. Values fetched
// through here go straight into the fill execution (a PowerShell child's
// environment) — they are never returned over IPC and never logged.
function vaultFillProvider() {
  return {
    unlocked: () => Boolean(vault && vault.isUnlocked()),
    login: (label) => (vault ? vault.getLoginSecret(label) : null),
    totpCode: (label) => {
      if (!vault) return null;
      const entry = vault.findByLabel(label);
      const secret = vault.getTotpSecret(label);
      if (!secret) return null;
      // Generated at execution moment.
      return { code: totp(secret), targetTitle: entry ? entry.targetTitle : '' };
    }
  };
}

// The OS owns special-folder locations — including OneDrive-redirected
// Desktops — so paths are always resolved from app.getPath, never trusted
// from a model proposal (which may guess the wrong profile name).
function specialFolders() {
  return {
    home: app.getPath('home'),
    desktop: app.getPath('desktop'),
    documents: app.getPath('documents'),
    downloads: app.getPath('downloads')
  };
}

function resolveAction(action) {
  return resolveActionPaths(action, specialFolders(), path);
}

function historyFile() {
  return path.join(app.getPath('userData'), 'history.json');
}

function loadHistory() {
  try {
    const data = JSON.parse(fs.readFileSync(historyFile(), 'utf8'));
    return Array.isArray(data) ? data : [];
  } catch (_) {
    return [];
  }
}

function saveHistory(messages) {
  fs.mkdirSync(app.getPath('userData'), { recursive: true });
  fs.writeFileSync(historyFile(), JSON.stringify(messages, null, 2), 'utf8');
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 800,
    minWidth: 860,
    minHeight: 560,
    backgroundColor: '#0e1116',
    title: 'Muse Bridge',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  mainWindow.removeMenu();
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

app.whenReady().then(() => {
  const defaultBridgePath = path.join(app.getPath('documents'), 'MuseBridge');
  settings = createSettingsStore(app.getPath('userData'), safeStorage, defaultBridgePath);
  bridge.ensureBridge(settings.getBridgePath());

  // ---- Teach lessons (local only; images live in userData) ----
  lessons = createLessonsStore(app.getPath('userData'));

  // ---- Auto-updater (public GitHub Releases feed; no credentials) ----
  updater = createUpdater({
    autoUpdater: loadAutoUpdater(),
    app,
    getWindow: () => mainWindow,
    log: console
  });

  // ---- Vault (encrypted credential store; starts locked) ----
  vault = new Vault(path.join(app.getPath('userData'), 'vault.json'));
  setInterval(() => {
    if (vault && settings && vault.autoLockDue(settings.getPublicSettings().vaultAutoLockMinutes)) {
      vault.lock();
      if (mainWindow) mainWindow.webContents.send('vault:auto-locked');
    }
  }, 20000);

  // ---- Settings ----
  ipcMain.handle('settings:get', () => settings.getPublicSettings());
  ipcMain.handle('settings:save', (_e, payload) => {
    const result = settings.save(payload || {});
    bridge.ensureBridge(settings.getBridgePath());
    return result;
  });
  ipcMain.handle('settings:clearKey', () => settings.clearKey());
  ipcMain.handle('settings:chooseBridgeFolder', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory', 'createDirectory'],
      title: 'Choose Bridge folder'
    });
    if (result.canceled || !result.filePaths.length) return settings.getPublicSettings();
    const updated = settings.save({ bridgePath: result.filePaths[0] });
    bridge.ensureBridge(result.filePaths[0]);
    return updated;
  });

  // ---- History ----
  ipcMain.handle('history:get', () => loadHistory());
  ipcMain.handle('history:save', (_e, messages) => {
    saveHistory(Array.isArray(messages) ? messages.slice(-500) : []);
    return true;
  });
  ipcMain.handle('history:clear', () => {
    saveHistory([]);
    return true;
  });

  // ---- Updater IPC (Settings: manual check + restart-to-update) ----
  ipcMain.handle('updater:check', () => (updater ? updater.checkNow() : { checked: false, reason: 'not-configured' }));
  ipcMain.handle('updater:install', () => (updater ? updater.requestInstall() : false));
  ipcMain.handle('app:version', () => app.getVersion());

  // ---- Teach lessons IPC ----
  // list/add/remove carry metadata only. The image data URL comes back
  // over IPC in exactly one case: the owner's own Lessons panel thumbnail
  // (lessons:image), same owner-display pattern as the Vault reveal.
  const lessonError = (err) => ({ ok: false, error: err.message });
  ipcMain.handle('lessons:list', () => (lessons ? lessons.list() : []));
  ipcMain.handle('lessons:add', (_e, payload) => {
    try {
      return { ok: true, lesson: lessons.add(payload || {}) };
    } catch (err) {
      return lessonError(err);
    }
  });
  ipcMain.handle('lessons:remove', (_e, id) => (lessons ? lessons.remove(id) : false));
  ipcMain.handle('lessons:context', () => (lessons ? lessons.getContext() : ''));
  ipcMain.handle('lessons:image', (_e, id) => (lessons ? lessons.getImageDataUrl(id) : null));

  // ---- Chat (live Muse Spark when a key exists, mock otherwise) ----
  // A user message may carry ONE screenshot (Teach mode): imageDataUrl is
  // validated here (type + size) and forwarded to the Spark client, which
  // sends it in vision format. It is never logged and never persisted by
  // main — history stays text-only in the renderer.
  const IMAGE_DATA_URL_RE = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=\s]+$/;
  const MAX_IMAGE_DATA_URL_CHARS = 12 * 1024 * 1024; // ~8 MB decoded + overhead
  ipcMain.handle('chat:send', async (_e, messages) => {
    const clean = (Array.isArray(messages) ? messages : [])
      .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
      .slice(-60)
      .map((m) => {
        const out = { role: m.role, content: m.content };
        if (
          m.role === 'user' &&
          typeof m.imageDataUrl === 'string' &&
          m.imageDataUrl.length <= MAX_IMAGE_DATA_URL_CHARS &&
          IMAGE_DATA_URL_RE.test(m.imageDataUrl)
        ) {
          out.imageDataUrl = m.imageDataUrl;
        }
        return out;
      });
    const apiKey = settings.getApiKey();
    if (!apiKey) {
      const lastUser = [...clean].reverse().find((m) => m.role === 'user');
      const hadImage = Boolean(lastUser && lastUser.imageDataUrl);
      return {
        mode: 'mock',
        reply:
          mockReply(lastUser ? lastUser.content : '', app.getPath('home')) +
          (hadImage
            ? '\n\n[Mock mode — your screenshot was attached, but Mock mode cannot see images. Add your Meta Model API key in Settings for live Muse Spark.]'
            : '')
      };
    }
    try {
      const reply = await chatCompletion({ apiKey, model: settings.getModel(), messages: clean });
      return { mode: 'live', reply };
    } catch (err) {
      if (err && err.code === 'VISION_REJECTED') {
        // Honest failure, per spec: say plainly the API rejected image
        // input, and still send the message text on its own.
        const textOnly = clean.map(({ role, content }) => ({ role, content }));
        try {
          const reply = await chatCompletion({ apiKey, model: settings.getModel(), messages: textOnly });
          return {
            mode: 'live',
            visionRejected: true,
            reply:
              '⚠️ The Meta Model API rejected the screenshot — it does not accept image input on this endpoint, so your message was sent as text only.\n\n' +
              reply
          };
        } catch (retryErr) {
          return { mode: 'error', reply: `Muse Spark could not be reached: ${retryErr.message}` };
        }
      }
      return { mode: 'error', reply: `Muse Spark could not be reached: ${err.message}` };
    }
  });

  // ---- Desktop tasks (renderer only ever PROPOSES; user approves; main executes) ----
  // HANDS actions (paste_to_app / copy_from_app / fill_login / fill_totp)
  // pass through the session guard first: never type over the user, never
  // type into a locked/switched session. opts: { mode, execId } — mode is
  // 'queue' for Night Queue steps, 'interactive' for approval-card steps.
  // The renderer asks main to resolve a proposed action's paths against the
  // real OS folders BEFORE rendering the approval card, so the path Michael
  // approves is the path that runs.
  ipcMain.handle('task:resolve', (_e, action) => resolveAction(action));

  ipcMain.handle('task:execute', async (_e, proposedAction, opts) => {
    // Resolve again at execution (defense in depth): no caller can run a
    // model-guessed profile path, whatever route the action arrived by.
    const action = resolveAction(proposedAction);
    const execId = opts && typeof opts.execId === 'string' ? opts.execId : null;
    const mode = opts && opts.mode === 'queue' ? 'queue' : 'interactive';

    if (action && sessionGuard.isHandsAction(action.type)) {
      // A fill against a locked vault parks instantly (existing behavior) —
      // don't make the user wait out the guard for a step that cannot run.
      const isFill = action.type === 'fill_login' || action.type === 'fill_totp';
      const vaultLocked = isFill && !(vault && vault.isUnlocked());
      if (!vaultLocked) {
        const state = { cancelled: false };
        if (execId) executions.set(execId, state);
        try {
          const verdict = await sessionGuard.runGuard({
            probe: guardProbe,
            mode,
            settings: settings.getPublicSettings(),
            isCancelled: () => state.cancelled,
            onStatus: (status) => {
              if (mainWindow && execId) {
                mainWindow.webContents.send('hands:status', { execId, ...status });
              }
            }
          });
          if (verdict.decision === 'CANCELLED') {
            return {
              ok: false,
              cancelled: true,
              output: 'Cancelled — nothing was typed.',
              summary: describeAction(action)
            };
          }
          if (verdict.decision === 'PARK') {
            return {
              ok: false,
              waitForUser: true,
              parkReason: verdict.reason,
              output: sessionGuard.parkMessage(verdict.reason),
              summary: describeAction(action)
            };
          }
        } finally {
          if (execId) executions.delete(execId);
        }
      }
    }

    const result = await executeAction(action, {
      shell,
      homePath: app.getPath('home'),
      specialFolders: specialFolders(),
      vaultFill: vaultFillProvider()
    });
    return { ...result, summary: describeAction(action) };
  });
  // Stop button during a guarded wait (interactive countdown).
  ipcMain.handle('task:cancel', (_e, execId) => {
    const state = executions.get(execId);
    if (!state) return false;
    state.cancelled = true;
    return true;
  });

  // ---- Vault IPC ----
  // Status + CRUD views carry labels/usernames only. Secrets come back over
  // IPC in exactly ONE case: the owner's own Vault panel reveal (explicit
  // click, unlocked vault), for display in that panel only.
  const vaultError = (err) => ({ ok: false, error: err.message, code: err.code || 'ERROR' });
  ipcMain.handle('vault:status', () => vault.status());
  ipcMain.handle('vault:create', async (_e, masterPassword) => {
    try { await vault.create(masterPassword); return { ok: true, ...vault.status() }; }
    catch (err) { return vaultError(err); }
  });
  ipcMain.handle('vault:unlock', async (_e, masterPassword) => {
    try { await vault.unlock(masterPassword); return { ok: true, ...vault.status() }; }
    catch (err) { return vaultError(err); }
  });
  ipcMain.handle('vault:lock', () => ({ ok: true, ...vault.lock() }));
  ipcMain.handle('vault:addEntry', async (_e, entry) => {
    try { return { ok: true, entries: await vault.addEntry(entry) }; }
    catch (err) { return vaultError(err); }
  });
  ipcMain.handle('vault:updateEntry', async (_e, id, entry) => {
    try { return { ok: true, entries: await vault.updateEntry(id, entry) }; }
    catch (err) { return vaultError(err); }
  });
  ipcMain.handle('vault:deleteEntry', async (_e, id) => {
    try { return { ok: true, entries: await vault.deleteEntry(id) }; }
    catch (err) { return vaultError(err); }
  });
  // Planning view for the assistant: labels + usernames ONLY.
  ipcMain.handle('vault:listForPlanning', () => vault.listForPlanning());
  // Owner's panel reveal — one field, explicit click, unlocked vault only.
  ipcMain.handle('vault:reveal', (_e, id, field) => {
    try { return { ok: true, value: vault.reveal(id, field) }; }
    catch (err) { return vaultError(err); }
  });
  // Current code for the owner's panel display (main-generated, panel only).
  ipcMain.handle('vault:currentCode', (_e, label) => {
    try {
      const secret = vault.getTotpSecret(label);
      if (!secret) return { ok: false, error: 'No authenticator secret on that entry.' };
      return { ok: true, code: totp(secret) };
    } catch (err) { return vaultError(err); }
  });

  // ---- Bridge ----
  ipcMain.handle('bridge:info', () => bridge.ensureBridge(settings.getBridgePath()));
  ipcMain.handle('bridge:listInbox', () => bridge.listInbox(settings.getBridgePath()));
  ipcMain.handle('bridge:import', (_e, name) => bridge.readInboxFile(settings.getBridgePath(), name));
  ipcMain.handle('bridge:exportPacket', (_e, target, messages) =>
    bridge.writePacket(settings.getBridgePath(), target === 'chatgpt' ? 'chatgpt' : 'claude-code', messages)
  );
  ipcMain.handle('bridge:openFolder', async () => {
    const { bridgePath } = bridge.ensureBridge(settings.getBridgePath());
    await shell.openPath(bridgePath);
    return bridgePath;
  });

  // ---- UI clipboard bridge (manual fast path, both directions) ----
  ipcMain.handle('clipboard:read', () => clipboard.readText());
  ipcMain.handle('clipboard:write', (_e, text) => {
    clipboard.writeText(String(text || ''));
    return true;
  });

  // ---- Dot test runner ----
  ipcMain.handle('dot:buildPacket', async (_e, { what, context }) => {
    const packet = dotTests.buildTestPacket({ what, context });
    const saved = await dotTests.writeTestPacket(settings.getBridgePath(), packet);
    return { packet, ...saved };
  });
  ipcMain.handle('dot:logResult', async (_e, { what, source, raw }) => {
    const verdicts = dotTests.parseVerdicts(raw);
    const logFile = await dotTests.appendTestLog(settings.getBridgePath(), { what, source, verdicts, raw });
    return { verdicts, logFile };
  });
  ipcMain.handle('dot:simulate', (_e, what) => dotTests.simulateDotResult(what));
  ipcMain.handle('dot:parse', (_e, raw) => dotTests.parseVerdicts(raw));

  // ---- Audit signal system ----
  ipcMain.handle('audit:package', (_e, item) => audit.writeAuditPacket(settings.getBridgePath(), item));

  // ---- Local store for sessions + night queue (whitelisted keys only) ----
  const STORE_KEYS = ['sessions', 'nightQueue', 'audits'];
  ipcMain.handle('store:get', (_e, key) => {
    if (!STORE_KEYS.includes(key)) return null;
    try {
      return JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), `${key}.json`), 'utf8'));
    } catch (_) {
      return null;
    }
  });
  ipcMain.handle('store:save', (_e, key, value) => {
    if (!STORE_KEYS.includes(key)) return false;
    fs.writeFileSync(path.join(app.getPath('userData'), `${key}.json`), JSON.stringify(value, null, 2), 'utf8');
    return true;
  });

  // ---- Night queue reporting ----
  ipcMain.handle('night:log', (_e, line) => nightQueue.appendNightLog(settings.getBridgePath(), String(line || '')));
  ipcMain.handle('night:summary', (_e, jobs) =>
    nightQueue.writeNightSummary(settings.getBridgePath(), Array.isArray(jobs) ? jobs : [])
  );

  createWindow();

  // Auto-update check on launch (no-op when not packaged / in dev).
  if (updater) {
    try {
      updater.checkOnLaunch();
    } catch (_) {
      // An updater failure must never block the app from starting.
    }
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
