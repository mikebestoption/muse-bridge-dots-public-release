'use strict';

// The renderer's only bridge to the main process. No Node access in the page.

const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (payload) => ipcRenderer.invoke('settings:save', payload),
  clearKey: () => ipcRenderer.invoke('settings:clearKey'),
  clearVimeoToken: () => ipcRenderer.invoke('settings:clearVimeoToken'),
  chooseBridgeFolder: () => ipcRenderer.invoke('settings:chooseBridgeFolder'),

  // The real on-disk path of a File the user dropped/picked, so main can
  // stream-copy a large video without the bytes crossing IPC.
  getFilePath: (file) => {
    try { return webUtils && file ? webUtils.getPathForFile(file) : ''; } catch (_) { return ''; }
  },

  getHistory: () => ipcRenderer.invoke('history:get'),
  saveHistory: (messages) => ipcRenderer.invoke('history:save', messages),
  clearHistory: () => ipcRenderer.invoke('history:clear'),

  sendChat: (messages) => ipcRenderer.invoke('chat:send', messages),

  // Auto-updater (public GitHub Releases feed)
  checkForUpdates: () => ipcRenderer.invoke('updater:check'),
  installUpdate: () => ipcRenderer.invoke('updater:install'),
  getAppVersion: () => ipcRenderer.invoke('app:version'),
  onUpdaterStatus: (cb) => ipcRenderer.on('updater:status', (_e, payload) => cb(payload)),

  // Teach lessons (metadata over IPC; image only for the owner's panel)
  lessonsList: () => ipcRenderer.invoke('lessons:list'),
  lessonsAdd: (payload) => ipcRenderer.invoke('lessons:add', payload),
  lessonsRemove: (id) => ipcRenderer.invoke('lessons:remove', id),
  lessonsImage: (id) => ipcRenderer.invoke('lessons:image', id),
  lessonsContext: () => ipcRenderer.invoke('lessons:context'),

  resolveTask: (action) => ipcRenderer.invoke('task:resolve', action),
  executeTask: (action, opts) => ipcRenderer.invoke('task:execute', action, opts || {}),
  cancelTask: (execId) => ipcRenderer.invoke('task:cancel', execId),
  onHandsStatus: (cb) => ipcRenderer.on('hands:status', (_e, payload) => cb(payload)),

  // Vault (status + CRUD carry labels/usernames only; reveal/currentCode are
  // the owner's own panel displays, explicit click, unlocked vault only)
  vaultStatus: () => ipcRenderer.invoke('vault:status'),
  vaultCreate: (masterPassword) => ipcRenderer.invoke('vault:create', masterPassword),
  vaultUnlock: (masterPassword) => ipcRenderer.invoke('vault:unlock', masterPassword),
  vaultLock: () => ipcRenderer.invoke('vault:lock'),
  vaultAddEntry: (entry) => ipcRenderer.invoke('vault:addEntry', entry),
  vaultUpdateEntry: (id, entry) => ipcRenderer.invoke('vault:updateEntry', id, entry),
  vaultDeleteEntry: (id) => ipcRenderer.invoke('vault:deleteEntry', id),
  vaultListForPlanning: () => ipcRenderer.invoke('vault:listForPlanning'),
  vaultReveal: (id, field) => ipcRenderer.invoke('vault:reveal', id, field),
  vaultCurrentCode: (label) => ipcRenderer.invoke('vault:currentCode', label),
  onVaultAutoLocked: (cb) => ipcRenderer.on('vault:auto-locked', cb),

  bridgeInfo: () => ipcRenderer.invoke('bridge:info'),
  listInbox: () => ipcRenderer.invoke('bridge:listInbox'),
  importInboxFile: (name) => ipcRenderer.invoke('bridge:import', name),
  exportPacket: (target, messages) => ipcRenderer.invoke('bridge:exportPacket', target, messages),
  openBridgeFolder: () => ipcRenderer.invoke('bridge:openFolder'),

  // UI clipboard bridge (manual fast path)
  readClipboard: () => ipcRenderer.invoke('clipboard:read'),
  writeClipboard: (text) => ipcRenderer.invoke('clipboard:write', text),

  // Dot test runner
  buildDotPacket: (payload) => ipcRenderer.invoke('dot:buildPacket', payload),
  logDotResult: (payload) => ipcRenderer.invoke('dot:logResult', payload),
  simulateDot: (what) => ipcRenderer.invoke('dot:simulate', what),
  parseVerdicts: (raw) => ipcRenderer.invoke('dot:parse', raw),

  // Audit signal system
  auditPackage: (item) => ipcRenderer.invoke('audit:package', item),

  // Loops (CRUD over the userData store; the runner lives in the renderer)
  loopsList: () => ipcRenderer.invoke('loops:list'),
  loopsGet: (id) => ipcRenderer.invoke('loops:get', id),
  loopsCreate: (data) => ipcRenderer.invoke('loops:create', data),
  loopsUpdate: (id, data) => ipcRenderer.invoke('loops:update', id, data),
  loopsRemove: (id) => ipcRenderer.invoke('loops:remove', id),
  loopsExportDoc: (id) => ipcRenderer.invoke('loops:exportDoc', id),

  // Teach-from-video SOPs
  sopsList: () => ipcRenderer.invoke('sops:list'),
  sopsGet: (id) => ipcRenderer.invoke('sops:get', id),
  sopsRemove: (id) => ipcRenderer.invoke('sops:remove', id),
  sopsExport: (id) => ipcRenderer.invoke('sops:export', id),
  videoIntakeVimeo: (url) => ipcRenderer.invoke('video:intakeVimeo', url),
  videoStageFile: (sourcePath) => ipcRenderer.invoke('video:stageFile', sourcePath),
  videoUpdateDuration: (id, durationSec) => ipcRenderer.invoke('video:updateDuration', id, durationSec),
  sopGenerate: (payload) => ipcRenderer.invoke('sop:generate', payload),
  sopToLoop: (id) => ipcRenderer.invoke('sop:toLoop', id),

  // Generic local store for sessions + night queue (whitelisted keys in main)
  storeGet: (key) => ipcRenderer.invoke('store:get', key),
  storeSave: (key, value) => ipcRenderer.invoke('store:save', key, value),

  // Night queue reporting
  nightLog: (line) => ipcRenderer.invoke('night:log', line),
  nightSummary: (jobs) => ipcRenderer.invoke('night:summary', jobs)
});
