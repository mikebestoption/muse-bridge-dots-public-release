'use strict';

// Vault — Michael's personal credential store, LastPass-style, local only.
//
// Security model:
// - The vault file lives in the app's userData folder and is AES-256-GCM
//   encrypted. The key is derived from the user's MASTER PASSWORD with
//   scrypt (random salt). The master password itself is never stored.
// - A wrong master password (or a tampered vault file) fails AES-GCM
//   authentication — decryption fails cleanly, no partial data.
// - The master password is UNRECOVERABLE by design: if it is forgotten,
//   the vault's contents are lost. There is no back door.
// - Secrets stay in the main process. The renderer (and therefore the
//   assistant/model) can only ever see entry LABELS and USERNAMES.
//   Passwords and TOTP secrets are reachable only through main-process
//   calls: the fill actions, and the owner's own Vault panel reveal
//   button (explicit click, unlocked vault only — that reveal goes to
//   the panel's own masked field, never into chat, history, or logs).
// - There is NO plaintext export, ever.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const VAULT_VERSION = 1;
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32, maxmem: 64 * 1024 * 1024 };

class VaultError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function deriveKey(masterPassword, salt) {
  return crypto.scryptSync(String(masterPassword), salt, SCRYPT.keylen, {
    N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: SCRYPT.maxmem
  });
}

function encryptEntries(masterPassword, salt, entries) {
  const key = deriveKey(masterPassword, salt);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const plaintext = Buffer.from(JSON.stringify({ entries }), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  key.fill(0);
  return {
    version: VAULT_VERSION,
    kdf: 'scrypt',
    scrypt: { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p },
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64')
  };
}

function decryptEntries(masterPassword, fileData) {
  const salt = Buffer.from(fileData.salt, 'base64');
  const key = deriveKey(masterPassword, salt);
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(fileData.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(fileData.tag, 'base64'));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(fileData.ciphertext, 'base64')),
      decipher.final()
    ]);
    const parsed = JSON.parse(plaintext.toString('utf8'));
    return Array.isArray(parsed.entries) ? parsed.entries : [];
  } catch (_) {
    throw new VaultError('WRONG_PASSWORD', 'Wrong master password, or the vault file is damaged. Nothing was decrypted.');
  } finally {
    key.fill(0);
  }
}

function newId() {
  return `v-${Date.now()}-${Math.floor(Math.random() * 1000000)}`;
}

// Sanitize an entry coming from the renderer: only known fields, all strings.
function sanitizeEntry(input, existing) {
  const e = existing || {};
  const pick = (field, fallback) =>
    typeof input[field] === 'string' ? input[field] : (fallback || '');
  return {
    id: e.id || newId(),
    label: pick('label', e.label).trim(),
    username: pick('username', e.username),
    password: pick('password', e.password),
    totpSecret: pick('totpSecret', e.totpSecret).replace(/\s+/g, ''),
    url: pick('url', e.url),
    targetTitle: pick('targetTitle', e.targetTitle),
    notes: pick('notes', e.notes),
    created: e.created || new Date().toISOString()
  };
}

class Vault {
  constructor(filePath) {
    this.filePath = filePath;
    this.masterPassword = null; // in memory ONLY while unlocked; never persisted
    this.salt = null;
    this.entries = null; // null while locked
    this.lastActivityAt = 0;
  }

  exists() {
    return fs.existsSync(this.filePath);
  }

  isUnlocked() {
    return this.entries !== null;
  }

  touch() {
    if (this.isUnlocked()) this.lastActivityAt = Date.now();
  }

  // Returns true when the vault has been unlocked longer than the limit.
  autoLockDue(limitMinutes) {
    if (!this.isUnlocked()) return false;
    if (!limitMinutes || limitMinutes <= 0) return false;
    return Date.now() - this.lastActivityAt > limitMinutes * 60 * 1000;
  }

  async create(masterPassword) {
    if (this.exists()) throw new VaultError('EXISTS', 'A vault already exists on this PC.');
    if (!masterPassword || String(masterPassword).length < 8) {
      throw new VaultError('WEAK', 'Master password must be at least 8 characters.');
    }
    this.salt = crypto.randomBytes(16);
    this.masterPassword = String(masterPassword);
    this.entries = [];
    this.touch();
    await this.persist();
    return this.status();
  }

  async unlock(masterPassword) {
    if (!this.exists()) throw new VaultError('NO_VAULT', 'No vault exists yet — create one first.');
    const fileData = JSON.parse(await fs.promises.readFile(this.filePath, 'utf8'));
    if (fileData.version !== VAULT_VERSION || fileData.kdf !== 'scrypt') {
      throw new VaultError('BAD_FORMAT', 'This vault file is not a supported format.');
    }
    this.entries = decryptEntries(String(masterPassword), fileData); // throws VaultError on wrong password
    this.salt = Buffer.from(fileData.salt, 'base64');
    this.masterPassword = String(masterPassword);
    this.touch();
    return this.status();
  }

  lock() {
    this.masterPassword = null;
    this.entries = null;
    this.salt = null;
    this.lastActivityAt = 0;
    return this.status();
  }

  async persist() {
    if (!this.isUnlocked()) throw new VaultError('LOCKED', 'Vault is locked.');
    const data = encryptEntries(this.masterPassword, this.salt, this.entries);
    await fs.promises.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.promises.writeFile(this.filePath, JSON.stringify(data, null, 2), 'utf8');
  }

  requireUnlocked() {
    if (!this.isUnlocked()) throw new VaultError('LOCKED', 'Vault is locked — unlock it first.');
    this.touch();
  }

  // ---- public views (NO secrets — safe for the renderer) ----

  status() {
    return {
      exists: this.exists(),
      unlocked: this.isUnlocked(),
      entries: this.isUnlocked() ? this.listPublic() : []
    };
  }

  listPublic() {
    this.requireUnlocked();
    return this.entries.map((e) => ({
      id: e.id,
      label: e.label,
      username: e.username,
      url: e.url,
      targetTitle: e.targetTitle,
      notes: e.notes,
      hasPassword: Boolean(e.password),
      hasTotp: Boolean(e.totpSecret)
    }));
  }

  // The planning view for the assistant/model: labels + usernames ONLY.
  // This is the only shape that may ever ride along with a chat payload.
  listForPlanning() {
    if (!this.isUnlocked()) return [];
    return this.entries.map((e) => ({ label: e.label, username: e.username }));
  }

  // ---- CRUD (secrets accepted from the owner's panel, never echoed back) ----

  async addEntry(input) {
    this.requireUnlocked();
    const entry = sanitizeEntry(input || {});
    if (!entry.label) throw new VaultError('BAD_ENTRY', 'Every entry needs a label (site or app name).');
    if (this.entries.some((e) => e.label.toLowerCase() === entry.label.toLowerCase())) {
      throw new VaultError('BAD_ENTRY', `An entry labeled "${entry.label}" already exists.`);
    }
    this.entries.push(entry);
    await this.persist();
    return this.listPublic();
  }

  async updateEntry(id, input) {
    this.requireUnlocked();
    const idx = this.entries.findIndex((e) => e.id === id);
    if (idx === -1) throw new VaultError('BAD_ENTRY', 'Entry not found.');
    const updated = sanitizeEntry(input || {}, this.entries[idx]);
    if (!updated.label) throw new VaultError('BAD_ENTRY', 'Every entry needs a label.');
    this.entries[idx] = updated;
    await this.persist();
    return this.listPublic();
  }

  async deleteEntry(id) {
    this.requireUnlocked();
    this.entries = this.entries.filter((e) => e.id !== id);
    await this.persist();
    return this.listPublic();
  }

  // ---- secret access (main process ONLY; never exposed to the renderer
  // as part of chat/history/logs) ----

  findByLabel(label) {
    if (!this.isUnlocked()) return null;
    const wanted = String(label || '').trim().toLowerCase();
    return this.entries.find((e) => e.label.toLowerCase() === wanted) || null;
  }

  // For fill_login: returns username/password + the entry's saved window
  // title. Caller must keep these out of any returned-to-renderer payload.
  getLoginSecret(label) {
    const entry = this.findByLabel(label);
    if (!entry) return null;
    this.touch();
    return { username: entry.username, password: entry.password, targetTitle: entry.targetTitle };
  }

  // For fill_totp: returns the raw TOTP secret so the main process can
  // generate the code at execution moment. Never leaves the main process.
  getTotpSecret(label) {
    const entry = this.findByLabel(label);
    if (!entry || !entry.totpSecret) return null;
    this.touch();
    return entry.totpSecret;
  }

  // Owner's-panel reveal (explicit click, unlocked only). Returns ONE field
  // for the panel's own display — main never writes it anywhere else.
  reveal(id, field) {
    this.requireUnlocked();
    const entry = this.entries.find((e) => e.id === id);
    if (!entry) throw new VaultError('BAD_ENTRY', 'Entry not found.');
    if (field === 'password') return entry.password;
    if (field === 'totpSecret') return entry.totpSecret;
    throw new VaultError('BAD_ENTRY', 'Unknown field.');
  }
}

module.exports = { Vault, VaultError };
