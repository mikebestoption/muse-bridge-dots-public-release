'use strict';

// Settings + API-key storage.
// - The API key is NEVER written in plaintext and NEVER logged.
// - When Electron safeStorage is available, the key is encrypted with it
//   (OS-backed: DPAPI on Windows, Keychain on macOS) and only the
//   base64 ciphertext is kept in settings.json in the app's userData folder.
// - When safeStorage is NOT available, the key is kept in memory only for
//   the current session and is not persisted to disk at all.

const fs = require('fs');
const path = require('path');

const DEFAULT_MODEL = 'muse-spark-1.3';
const ALLOWED_MODELS = ['muse-spark-1.3', 'muse-spark-1.1'];
// Local transcription (v0.4.5): whisper model ids + language override.
// Kept as literals here so the settings store stays dependency-free;
// src/transcribeCore.js owns the model details.
const ALLOWED_WHISPER_MODELS = ['base', 'small', 'large-v3-turbo'];
const DEFAULT_WHISPER_MODEL = 'base';
const ALLOWED_TRANSCRIBE_LANGUAGES = ['auto', 'en', 'es'];

function createSettingsStore(userDataPath, safeStorage, defaultBridgePath) {
  const settingsFile = path.join(userDataPath, 'settings.json');
  let inMemoryKey = null; // only used when safeStorage is unavailable
  let inMemoryVimeoToken = null; // same treatment as the API key
  let inMemoryGithubToken = null; // same treatment as the API key

  function readRaw() {
    try {
      if (fs.existsSync(settingsFile)) {
        return JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
      }
    } catch (_) {
      // Corrupt settings file: fall back to defaults rather than crashing.
    }
    return {};
  }

  function writeRaw(data) {
    fs.mkdirSync(userDataPath, { recursive: true });
    fs.writeFileSync(settingsFile, JSON.stringify(data, null, 2), 'utf8');
  }

  function getPublicSettings() {
    const raw = readRaw();
    return {
      model: ALLOWED_MODELS.includes(raw.model) ? raw.model : DEFAULT_MODEL,
      bridgePath: raw.bridgePath || defaultBridgePath,
      auditNightDefault: Boolean(raw.auditNightDefault),
      vaultAutoLockMinutes: Number.isFinite(raw.vaultAutoLockMinutes) && raw.vaultAutoLockMinutes >= 0
        ? raw.vaultAutoLockMinutes
        : 10,
      handsIdleThresholdSeconds: Number.isFinite(raw.handsIdleThresholdSeconds) && raw.handsIdleThresholdSeconds > 0
        ? raw.handsIdleThresholdSeconds
        : 30,
      handsMaxWaitMinutes: Number.isFinite(raw.handsMaxWaitMinutes) && raw.handsMaxWaitMinutes > 0
        ? raw.handsMaxWaitMinutes
        : 30,
      whisperModel: ALLOWED_WHISPER_MODELS.includes(raw.whisperModel) ? raw.whisperModel : DEFAULT_WHISPER_MODEL,
      transcribeLanguage: ALLOWED_TRANSCRIBE_LANGUAGES.includes(raw.transcribeLanguage)
        ? raw.transcribeLanguage
        : 'auto',
      hasKey: Boolean(raw.encryptedKey) || Boolean(inMemoryKey),
      keyPersisted: Boolean(raw.encryptedKey),
      hasVimeoToken: Boolean(raw.encryptedVimeoToken) || Boolean(inMemoryVimeoToken),
      hasGithubToken: Boolean(raw.encryptedGithubToken) || Boolean(inMemoryGithubToken),
      encryptionAvailable: Boolean(safeStorage && safeStorage.isEncryptionAvailable())
    };
  }

  function getModel() {
    return getPublicSettings().model;
  }

  function getBridgePath() {
    return getPublicSettings().bridgePath;
  }

  function getApiKey() {
    if (inMemoryKey) return inMemoryKey;
    const raw = readRaw();
    if (!raw.encryptedKey) return null;
    if (!safeStorage || !safeStorage.isEncryptionAvailable()) return null;
    try {
      return safeStorage.decryptString(Buffer.from(raw.encryptedKey, 'base64'));
    } catch (_) {
      return null;
    }
  }

  function getVimeoToken() {
    if (inMemoryVimeoToken) return inMemoryVimeoToken;
    const raw = readRaw();
    if (!raw.encryptedVimeoToken) return null;
    if (!safeStorage || !safeStorage.isEncryptionAvailable()) return null;
    try {
      return safeStorage.decryptString(Buffer.from(raw.encryptedVimeoToken, 'base64'));
    } catch (_) {
      return null;
    }
  }

  function getGithubToken() {
    if (inMemoryGithubToken) return inMemoryGithubToken;
    const raw = readRaw();
    if (!raw.encryptedGithubToken) return null;
    if (!safeStorage || !safeStorage.isEncryptionAvailable()) return null;
    try {
      return safeStorage.decryptString(Buffer.from(raw.encryptedGithubToken, 'base64'));
    } catch (_) {
      return null;
    }
  }

  // apiKey: string to set, '' to leave unchanged is handled by caller passing null.
  function save({ model, bridgePath, apiKey, vimeoToken, githubToken, auditNightDefault, vaultAutoLockMinutes, handsIdleThresholdSeconds, handsMaxWaitMinutes, whisperModel, transcribeLanguage }) {
    const raw = readRaw();
    if (ALLOWED_WHISPER_MODELS.includes(whisperModel)) raw.whisperModel = whisperModel;
    if (ALLOWED_TRANSCRIBE_LANGUAGES.includes(transcribeLanguage)) raw.transcribeLanguage = transcribeLanguage;
    if (typeof auditNightDefault === 'boolean') raw.auditNightDefault = auditNightDefault;
    if (Number.isFinite(vaultAutoLockMinutes) && vaultAutoLockMinutes >= 0) {
      raw.vaultAutoLockMinutes = Math.round(vaultAutoLockMinutes);
    }
    if (Number.isFinite(handsIdleThresholdSeconds) && handsIdleThresholdSeconds > 0) {
      raw.handsIdleThresholdSeconds = Math.round(handsIdleThresholdSeconds);
    }
    if (Number.isFinite(handsMaxWaitMinutes) && handsMaxWaitMinutes > 0) {
      raw.handsMaxWaitMinutes = Math.round(handsMaxWaitMinutes);
    }
    if (ALLOWED_MODELS.includes(model)) raw.model = model;
    if (typeof bridgePath === 'string' && bridgePath.trim()) raw.bridgePath = bridgePath.trim();

    if (typeof apiKey === 'string' && apiKey.length > 0) {
      if (safeStorage && safeStorage.isEncryptionAvailable()) {
        raw.encryptedKey = safeStorage.encryptString(apiKey).toString('base64');
        inMemoryKey = null;
      } else {
        // No OS encryption available: session-only, never written to disk.
        delete raw.encryptedKey;
        inMemoryKey = apiKey;
      }
    }
    if (typeof vimeoToken === 'string' && vimeoToken.length > 0) {
      if (safeStorage && safeStorage.isEncryptionAvailable()) {
        raw.encryptedVimeoToken = safeStorage.encryptString(vimeoToken).toString('base64');
        inMemoryVimeoToken = null;
      } else {
        delete raw.encryptedVimeoToken;
        inMemoryVimeoToken = vimeoToken;
      }
    }
    if (typeof githubToken === 'string' && githubToken.length > 0) {
      if (safeStorage && safeStorage.isEncryptionAvailable()) {
        raw.encryptedGithubToken = safeStorage.encryptString(githubToken).toString('base64');
        inMemoryGithubToken = null;
      } else {
        delete raw.encryptedGithubToken;
        inMemoryGithubToken = githubToken;
      }
    }
    writeRaw(raw);
    return getPublicSettings();
  }

  function clearKey() {
    const raw = readRaw();
    delete raw.encryptedKey;
    inMemoryKey = null;
    writeRaw(raw);
    return getPublicSettings();
  }

  function clearVimeoToken() {
    const raw = readRaw();
    delete raw.encryptedVimeoToken;
    inMemoryVimeoToken = null;
    writeRaw(raw);
    return getPublicSettings();
  }

  function clearGithubToken() {
    const raw = readRaw();
    delete raw.encryptedGithubToken;
    inMemoryGithubToken = null;
    writeRaw(raw);
    return getPublicSettings();
  }

  return { getPublicSettings, getModel, getBridgePath, getApiKey, getVimeoToken, getGithubToken, save, clearKey, clearVimeoToken, clearGithubToken };
}

module.exports = { createSettingsStore, ALLOWED_MODELS, DEFAULT_MODEL, ALLOWED_WHISPER_MODELS, DEFAULT_WHISPER_MODEL, ALLOWED_TRANSCRIBE_LANGUAGES };
