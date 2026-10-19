'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell, safeStorage, clipboard, protocol } = require('electron');
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

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
const attachmentsLib = require('./src/attachments');
const { createLoopsStore } = require('./src/loops');
const loopsCore = require('./src/loopsCore');
const { createSopsStore, fetchVimeoOEmbed, fetchVimeoVideo, fetchVimeoTranscript, mockSop } = require('./src/sops');
const sopCore = require('./src/sopCore');
const { createVideoStore, MAX_VIDEO_BYTES } = require('./src/videoFiles');
const { createRequestsChannel } = require('./src/githubRequests');

let settings = null;
let mainWindow = null;
let vault = null;
let lessons = null;
let updater = null;
let loops = null;
let sops = null;
let videos = null;
let requestsChannel = null;

// Staged videos are served to the renderer's hidden <video> element for
// frame sampling through a private scheme (streaming, range-capable),
// so a 500 MB recording never crosses IPC as bytes. Registered before
// app readiness, as Electron requires for privileged schemes.
try {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: 'muse-video',
      privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true, corsEnabled: true }
    }
  ]);
} catch (_) { /* non-Electron load (bare node) — video serving is inert */ }

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
    backgroundColor: '#ffffff',
    icon: path.join(__dirname, 'renderer', 'bestoption-mark.png'),
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

  // ---- Loops + SOPs + staged videos (all local, userData only) ----
  loops = createLoopsStore(app.getPath('userData'));
  sops = createSopsStore(app.getPath('userData'));
  videos = createVideoStore(app.getPath('userData'));
  try {
    protocol.handle('muse-video', async (request) => {
      const id = decodeURIComponent(new URL(request.url).pathname.replace(/^\//, ''));
      const file = videos ? videos.getPath(id) : null;
      if (!file) return new Response('Not found', { status: 404 });
      const stat = fs.statSync(file);
      const ext = path.extname(file).toLowerCase();
      const type = ext === '.webm' ? 'video/webm' : ext === '.mov' || ext === '.m4v' ? 'video/quicktime' : 'video/mp4';
      const headers = {
        'Content-Type': type,
        'Accept-Ranges': 'bytes',
        'Access-Control-Allow-Origin': '*'
      };
      const range = request.headers.get('range');
      const match = range ? /^bytes=(\d*)-(\d*)$/.exec(range) : null;
      if (match) {
        const start = match[1] ? parseInt(match[1], 10) : 0;
        const end = match[2] ? parseInt(match[2], 10) : stat.size - 1;
        if (Number.isFinite(start) && Number.isFinite(end) && start <= end && start < stat.size) {
          headers['Content-Range'] = `bytes ${start}-${end}/${stat.size}`;
          headers['Content-Length'] = String(end - start + 1);
          return new Response(Readable.toWeb(fs.createReadStream(file, { start, end })), { status: 206, headers });
        }
        return new Response('Range not satisfiable', { status: 416 });
      }
      headers['Content-Length'] = String(stat.size);
      return new Response(Readable.toWeb(fs.createReadStream(file)), { status: 200, headers });
    });
  } catch (_) { /* protocol unavailable — renderer falls back honestly */ }

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
  ipcMain.handle('settings:clearVimeoToken', () => settings.clearVimeoToken());
  ipcMain.handle('settings:clearGithubToken', () => settings.clearGithubToken());
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

  // ---- Ask Muse IPC (v0.4.1) ----
  // The channel talks to the private repo's requests/ folder ONLY,
  // with the Settings GitHub token. The renderer sees request text,
  // statuses, and hasToken booleans — never the token itself.
  requestsChannel = createRequestsChannel({
    userDataPath: app.getPath('userData'),
    getToken: () => settings.getGithubToken(),
    appVersion: app.getVersion()
  });
  const requestsError = (err) => ({ ok: false, error: err.message });
  ipcMain.handle('requests:list', () => requestsChannel.list());
  ipcMain.handle('requests:refresh', async () => requestsChannel.refresh());
  ipcMain.handle('requests:send', async (_e, payload) => {
    try {
      return await requestsChannel.compose(payload || {});
    } catch (err) {
      return requestsError(err);
    }
  });
  ipcMain.handle('requests:retry', async (_e, id) => {
    try {
      return await requestsChannel.retry(id);
    } catch (err) {
      return requestsError(err);
    }
  });
  ipcMain.handle('requests:removeLocal', (_e, id) => (requestsChannel ? requestsChannel.removeLocal(id) : false));

  // ---- Loops IPC ----
  // CRUD over the pure store; the runner itself lives in the renderer
  // (it drives the existing chat/task IPCs through its injected deps).
  const loopError = (err) => ({ ok: false, error: err.message });
  ipcMain.handle('loops:list', () => (loops ? loops.list() : []));
  ipcMain.handle('loops:get', (_e, id) => (loops ? loops.get(id) : null));
  ipcMain.handle('loops:create', (_e, data) => {
    try { return { ok: true, loop: loops.create(data || {}) }; } catch (err) { return loopError(err); }
  });
  ipcMain.handle('loops:update', (_e, id, data) => {
    try { return { ok: true, loop: loops.update(id, data || {}) }; } catch (err) { return loopError(err); }
  });
  ipcMain.handle('loops:remove', (_e, id) => (loops ? loops.remove(id) : false));
  ipcMain.handle('loops:exportDoc', async (_e, id) => {
    const loop = loops ? loops.get(id) : null;
    if (!loop) return { ok: false, error: 'That loop no longer exists.' };
    const saved = await bridge.writeOutboxFile(
      settings.getBridgePath(),
      `${loopsCore.slugify(loop.name)}-loop.md`,
      loopsCore.loopToMarkdown(loop)
    );
    return { ok: true, ...saved };
  });

  // ---- Teach-from-video: SOP IPC ----
  const sopError = (err) => ({ ok: false, error: err.message });
  ipcMain.handle('sops:list', () => (sops ? sops.list() : []));
  ipcMain.handle('sops:get', (_e, id) => (sops ? sops.get(id) : null));
  ipcMain.handle('sops:remove', (_e, id) => (sops ? sops.remove(id) : false));
  ipcMain.handle('sops:export', async (_e, id) => {
    const record = sops ? sops.get(id) : null;
    if (!record) return { ok: false, error: 'That SOP record no longer exists.' };
    if (!record.sop) return { ok: false, error: 'No SOP has been generated for that recording yet.' };
    const markdown = record.markdown || sopCore.sopToMarkdown({
      title: record.title, sop: record.sop, sourceLabel: record.sourceLabel,
      transcriptSource: record.transcriptSource, frameCount: record.frameCount, createdAt: record.createdAt
    });
    const saved = await bridge.writeOutboxFile(
      settings.getBridgePath(),
      `${loopsCore.slugify(record.sop.title || record.title)}-sop.md`,
      markdown
    );
    return { ok: true, ...saved };
  });

  // Vimeo link intake: oEmbed metadata always (public). With Michael's
  // Vimeo token (Settings), also captions + a downloadable file for
  // frame sampling. Without one — or when Vimeo exposes no download —
  // the record stays an honest intake: nothing is analyzed from a
  // thumbnail, and the note says exactly what is missing.
  ipcMain.handle('video:intakeVimeo', async (_e, rawUrl) => {
    try {
      const url = String(rawUrl || '').trim();
      const parsed = sopCore.parseVimeoUrl(url);
      if (!parsed) return { ok: false, error: 'That does not look like a Vimeo link. Paste a vimeo.com video URL.' };
      let meta = null;
      try { meta = await fetchVimeoOEmbed(url); } catch (_) { /* private/odd links: id-only intake */ }
      const notes = [];
      let stagedId = '';
      let transcriptText = '';
      let transcriptSource = 'none';
      const token = settings.getVimeoToken();
      if (token) {
        try {
          const transcript = await fetchVimeoTranscript(parsed.id, token);
          if (transcript) {
            transcriptText = transcript.text;
            transcriptSource = 'vimeo-captions';
          }
        } catch (_) { /* captions are best-effort */ }
        try {
          const video = await fetchVimeoVideo(parsed.id, token);
          const download = sopCore.pickDownloadLink(video, MAX_VIDEO_BYTES);
          if (download) {
            const target = videos.newTarget('.mp4');
            const res = await fetch(download.link);
            if (res.ok && res.body) {
              let bytes = 0;
              const { Transform } = require('stream');
              const counting = new Transform({
                transform(chunk, _enc, cb) {
                  bytes += chunk.length;
                  if (bytes > MAX_VIDEO_BYTES) { cb(new Error('download exceeds 500 MB')); return; }
                  cb(null, chunk);
                }
              });
              await pipeline(Readable.fromWeb(res.body), counting, fs.createWriteStream(target.absPath));
              videos.register(target.id, target.absPath, {
                name: meta ? meta.title : `vimeo-${parsed.id}`,
                size: bytes,
                source: 'vimeo-download'
              });
              stagedId = target.id;
            }
          } else {
            notes.push('Vimeo did not offer a downloadable file for this video (downloads are not enabled for it), so frames cannot be sampled from the link. Add the video file itself to sample frames.');
          }
        } catch (err) {
          notes.push(`Vimeo API lookup failed (${err.message}) — metadata only for now.`);
        }
      } else {
        notes.push('Add the video file or a Vimeo token to analyze the recording itself. Right now only the link and its public title/thumbnail are saved — nothing has been analyzed.');
      }
      const record = sops.createIntake({
        sourceKind: 'vimeo',
        title: meta ? meta.title : `Vimeo video ${parsed.id}`,
        sourceLabel: `vimeo.com/${parsed.id}`,
        sourceUrl: url,
        thumbnailUrl: meta ? meta.thumbnailUrl : '',
        durationSec: meta ? meta.durationSec : null,
        stagedId,
        note: notes.join(' ')
      });
      if (transcriptText) sops.update(record.id, { transcriptText, transcriptSource });
      const fresh = sops.list().find((r) => r.id === record.id) || record;
      return { ok: true, record: fresh };
    } catch (err) {
      return sopError(err);
    }
  });

  // Local video file intake: streamed copy into userData (500 MB cap),
  // then an intake record pointing at the staged copy.
  ipcMain.handle('video:stageFile', async (_e, sourcePath) => {
    try {
      const staged = await videos.stageCopy(String(sourcePath || ''));
      const base = staged.name.replace(/\.[^.]+$/, '');
      const record = sops.createIntake({
        sourceKind: 'file',
        title: base || staged.name,
        sourceLabel: staged.name,
        stagedId: staged.id,
        note: ''
      });
      return { ok: true, record, staged };
    } catch (err) {
      return sopError(err);
    }
  });

  ipcMain.handle('video:updateDuration', (_e, id, durationSec) => {
    try {
      if (!sops || !Number.isFinite(durationSec)) return false;
      const record = sops.get(id);
      if (!record) return false;
      sops.update(id, { durationSec });
      return true;
    } catch (_) {
      return false;
    }
  });

  // SOP generation. Frames arrive as validated JPEG data URLs from the
  // renderer's sampler; the transcript comes from the record (Vimeo
  // captions) or a user-supplied override (their transcript file).
  // Mock mode returns the deterministic, clearly-labeled mock SOP.
  ipcMain.handle('sop:generate', async (_e, payload) => {
    try {
      const { recordId, frames, transcriptText } = payload || {};
      const record = sops ? sops.get(recordId) : null;
      if (!record) return { ok: false, error: 'That SOP record no longer exists.' };
      const frameList = (Array.isArray(frames) ? frames : [])
        .filter((f) => typeof f === 'string' && /^data:image\/(jpeg|png|webp);base64,/.test(f) && f.length <= MAX_IMAGE_DATA_URL_CHARS)
        .slice(0, sopCore.MAX_FRAMES);
      let transcript = record.transcriptText || '';
      let transcriptSource = record.transcriptSource || 'none';
      if (typeof transcriptText === 'string' && transcriptText.trim()) {
        transcript = transcriptText;
        transcriptSource = 'user-file';
        sops.update(recordId, { transcriptText: transcript, transcriptSource });
      }
      sops.update(recordId, { frameCount: frameList.length });
      const apiKey = settings.getApiKey();
      if (!apiKey) {
        const sop = mockSop({ title: record.title, transcriptText: transcript, frameCount: frameList.length });
        return { ok: true, mode: 'mock', record: sops.update(recordId, { sop }) };
      }
      const runVision = async (withFrames) => {
        const userText = sopCore.buildSopUserText({
          title: record.title,
          transcript,
          frameCount: withFrames ? frameList.length : 0,
          transcriptSource
        });
        const message = { role: 'user', content: userText };
        if (withFrames && frameList.length) message.imageDataUrls = frameList;
        const reply = await chatCompletion({
          apiKey,
          model: settings.getModel(),
          messages: [message],
          system: sopCore.SOP_SYSTEM_PROMPT
        });
        return sopCore.parseSopReply(reply);
      };
      try {
        const sop = await runVision(true);
        return { ok: true, mode: 'live', record: sops.update(recordId, { sop }) };
      } catch (err) {
        if (err && err.code === 'VISION_REJECTED' && frameList.length) {
          // Honest degradation, same rule as chat: say the API rejected
          // the frames and generate from the transcript alone.
          const sop = await runVision(false);
          const updated = sops.update(recordId, { sop, frameCount: 0 });
          return { ok: true, mode: 'live', visionRejected: true, record: updated };
        }
        throw err;
      }
    } catch (err) {
      return sopError(err);
    }
  });

  // SOP -> Loop draft. Creates the loop in the store (draft only —
  // nothing runs) and returns it so the renderer can open the builder.
  ipcMain.handle('sop:toLoop', (_e, id) => {
    try {
      const record = sops ? sops.get(id) : null;
      if (!record) return { ok: false, error: 'That SOP record no longer exists.' };
      if (!record.sop) return { ok: false, error: 'Generate the SOP first — then it can become a Loop.' };
      const draft = sopCore.sopToLoopDraft(record);
      return { ok: true, loop: loops.create(draft) };
    } catch (err) {
      return sopError(err);
    }
  });

  // ---- Chat (live Muse Spark when a key exists, mock otherwise) ----
  // A user message may carry screenshots (Teach mode): imageDataUrl
  // (single, v0.3.3 shape) and/or imageDataUrls (v0.3.4, up to 4) are
  // validated here (type + size each) and forwarded to the Spark
  // client, which sends them in vision format. Images are never logged
  // and never persisted by main. Attached text documents ride inside
  // the message content itself, in [Attached document: ...] blocks.
  const IMAGE_DATA_URL_RE = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=\s]+$/;
  const MAX_IMAGE_DATA_URL_CHARS = 12 * 1024 * 1024; // ~8 MB decoded + overhead
  const MAX_IMAGES_PER_MESSAGE = 4;
  const isValidImageDataUrl = (value) =>
    typeof value === 'string' &&
    value.length <= MAX_IMAGE_DATA_URL_CHARS &&
    IMAGE_DATA_URL_RE.test(value);
  ipcMain.handle('chat:send', async (_e, messages) => {
    const clean = (Array.isArray(messages) ? messages : [])
      .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
      .slice(-60)
      .map((m) => {
        const out = { role: m.role, content: m.content };
        if (m.role === 'user') {
          if (isValidImageDataUrl(m.imageDataUrl)) {
            out.imageDataUrl = m.imageDataUrl;
          }
          if (Array.isArray(m.imageDataUrls)) {
            const urls = m.imageDataUrls.filter(isValidImageDataUrl).slice(0, MAX_IMAGES_PER_MESSAGE);
            if (urls.length) out.imageDataUrls = urls;
          }
        }
        return out;
      });
    const apiKey = settings.getApiKey();
    if (!apiKey) {
      const lastUser = [...clean].reverse().find((m) => m.role === 'user');
      const hadImage = Boolean(
        lastUser && (lastUser.imageDataUrl || (lastUser.imageDataUrls && lastUser.imageDataUrls.length))
      );
      const docNames = lastUser ? attachmentsLib.extractDocumentNames(lastUser.content) : [];
      // The mock brain sees the message with document bodies stripped
      // to one-line markers — it acknowledges attachments by name, it
      // never echoes a whole document back.
      const mockText = lastUser ? attachmentsLib.stripDocumentBlocks(lastUser.content) : '';
      let note = '';
      if (hadImage) {
        note += '\n\n[Mock mode — your screenshot was attached, but Mock mode cannot see images. Add your Meta Model API key in Settings for live Muse Spark.]';
      }
      if (docNames.length) {
        note +=
          `\n\n[Mock mode — your ${docNames.length === 1 ? 'document was' : 'documents were'} attached ` +
          `(${docNames.join(', ')}), but Mock mode cannot read file contents. Add your Meta Model API key in Settings for live Muse Spark.]`;
      }
      return {
        mode: 'mock',
        reply: mockReply(mockText, app.getPath('home')) + note
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
