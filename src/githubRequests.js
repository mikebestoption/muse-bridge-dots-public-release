'use strict';

// Ask Muse — GitHub channel (Muse Bridge v0.4.1, main process only).
//
// Sends Michael's in-app requests to the `requests/` folder of the
// private Muse Bridge repo and reads back the status files Muse's
// side writes there (docs/REQUESTS-PROTOCOL.md is the contract).
//
// HARD SCOPE RULES:
//   - The GitHub token (Settings, stored encrypted like the API key)
//     is used ONLY against this one repo and ONLY for paths under
//     `requests/`: GET the folder listing, GET / PUT request files,
//     GET status files. The client below refuses any other path —
//     there is no code path that calls another repo endpoint.
//   - The token is never logged, never written to disk by this module,
//     and never included in any returned object. Errors are reduced
//     to an HTTP status + GitHub's message, and defensively stripped
//     of the token value should GitHub ever echo it.
//   - Request text is Michael's own words, sent verbatim. Nothing is
//     added to it — no telemetry, no tracking id beyond the header
//     block the protocol defines.
//
// Local state (userData/requests-local.json): the requests this
// machine composed (sent + drafts), plus a cache of the last repo
// refresh, so the panel works offline and never shows an error wall.
// Statuses are READ-ONLY from the app's side — the app never writes
// a status file.
//
// All network goes through an injected fetch (tests use a fake GitHub;
// no test ever calls the real API).

const fs = require('fs');
const os = require('os');
const path = require('path');
const core = require('./requestsCore');

const OWNER = 'mikebestoption';
const REPO = 'mikebestoption-Muse-Bridge';
const API_BASE = 'https://api.github.com';
const REQUESTS_DIR = 'requests';

function createGitHubClient({ token, fetchImpl }) {
  const doFetch = fetchImpl || fetch;
  if (typeof token !== 'string' || !token) throw new Error('A GitHub token is required.');

  function assertScopedPath(p) {
    if (typeof p !== 'string' || !p.startsWith(`${REQUESTS_DIR}/`) || p.includes('..')) {
      throw new Error(`Refused: the Ask Muse channel may only touch ${REQUESTS_DIR}/ paths.`);
    }
  }

  async function raw(method, urlPath, body) {
    let res;
    try {
      res = await doFetch(`${API_BASE}${urlPath}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'muse-bridge',
          ...(body ? { 'Content-Type': 'application/json' } : {})
        },
        body: body ? JSON.stringify(body) : undefined
      });
    } catch (err) {
      throw new Error(`GitHub is unreachable (${err.message}).`);
    }
    return res;
  }

  async function errorFrom(res) {
    let message = '';
    try {
      const data = await res.json();
      if (data && typeof data.message === 'string') message = data.message;
    } catch (_) { /* non-JSON error body */ }
    const safe = message && !message.includes(token) ? `: ${message}` : '';
    return new Error(`GitHub answered HTTP ${res.status}${safe}.`);
  }

  return {
    // GET requests/ — one listing carries both the request files
    // (REQ-*.md) and the per-request status dirs (REQ-*). 404 = the
    // folder does not exist yet (nothing ever sent) → empty list.
    async listRequestsDir() {
      const res = await raw('GET', `/repos/${OWNER}/${REPO}/contents/${REQUESTS_DIR}`);
      if (res.status === 404) return [];
      if (!res.ok) throw await errorFrom(res);
      const data = await res.json();
      if (!Array.isArray(data)) return [];
      return data.map((e) => ({ name: e.name, path: e.path, type: e.type }));
    },

    // GET one file under requests/ → decoded text, or null on 404.
    async getFileText(p) {
      assertScopedPath(p);
      const res = await raw('GET', `/repos/${OWNER}/${REPO}/contents/${p}`);
      if (res.status === 404) return null;
      if (!res.ok) throw await errorFrom(res);
      const data = await res.json();
      if (!data || data.encoding !== 'base64' || typeof data.content !== 'string') return null;
      return Buffer.from(data.content.replace(/\s/g, ''), 'base64').toString('utf8');
    },

    // PUT one new file under requests/ (create; the channel checks
    // existence first, so no sha/update path is ever used).
    async putFileText(p, text, message) {
      assertScopedPath(p);
      const res = await raw('PUT', `/repos/${OWNER}/${REPO}/contents/${p}`, {
        message,
        content: Buffer.from(String(text), 'utf8').toString('base64')
      });
      if (!res.ok) throw await errorFrom(res);
      const data = await res.json();
      return { sha: data && data.commit ? data.commit.sha : '' };
    }
  };
}

function createRequestsChannel({ userDataPath, getToken, hostname, appVersion, fetchImpl, now }) {
  if (typeof userDataPath !== 'string' || !userDataPath) {
    throw new Error('createRequestsChannel requires a userData path.');
  }
  if (typeof getToken !== 'function') {
    throw new Error('createRequestsChannel requires a getToken function.');
  }
  const localFile = path.join(userDataPath, 'requests-local.json');
  const machine = typeof hostname === 'string' && hostname ? hostname : os.hostname();
  const version = typeof appVersion === 'string' ? appVersion : '';
  const clock = typeof now === 'function' ? now : () => new Date();

  // Local record shape:
  //   { id, type, text, title, createdAt, origin: 'sent'|'draft'|'remote',
  //     localStatus: null | 'draft' | 'send-failed', lastError: '',
  //     remote: null | { status, version, updated, note } }
  // origin 'remote' = composed on ANOTHER machine (or by hand) and
  // discovered in the repo; this machine keeps no copy of its text
  // beyond what refresh fetched for display.
  function readLocal() {
    try {
      if (fs.existsSync(localFile)) {
        const parsed = JSON.parse(fs.readFileSync(localFile, 'utf8'));
        if (parsed && Array.isArray(parsed.items)) {
          return { items: parsed.items, checkedAt: parsed.checkedAt || '' };
        }
      }
    } catch (_) {
      // Corrupt local file: start clean rather than crash the panel.
    }
    return { items: [], checkedAt: '' };
  }

  function writeLocal(state) {
    fs.mkdirSync(userDataPath, { recursive: true });
    fs.writeFileSync(localFile, JSON.stringify(state, null, 2), 'utf8');
  }

  function displayStatus(record) {
    if (record.remote && record.remote.status) return record.remote.status;
    if (record.origin === 'sent' || record.origin === 'remote') return 'sent';
    return record.localStatus || 'draft';
  }

  function toPublic(record, state) {
    const statusInfo = record.remote || null;
    const status = displayStatus(record);
    return {
      id: record.id,
      type: core.isRequestType(record.type) ? record.type : 'task',
      typeLabel: core.TYPE_LABELS[core.isRequestType(record.type) ? record.type : 'task'],
      title: record.title || core.requestTitle(record.text),
      text: record.text || '',
      createdAt: record.createdAt || '',
      origin: record.origin,
      status,
      statusLabel: core.statusLabel(status, statusInfo),
      statusVersion: statusInfo ? statusInfo.version || '' : '',
      statusNote: statusInfo ? statusInfo.note || '' : '',
      statusUpdated: statusInfo ? statusInfo.updated || '' : '',
      lastError: record.localStatus === 'send-failed' ? record.lastError || '' : '',
      canRetry: record.origin === 'draft',
      checkedAt: state.checkedAt || ''
    };
  }

  function publicList(state) {
    const items = [...state.items]
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)) || String(b.id).localeCompare(String(a.id)))
      .map((r) => toPublic(r, state));
    return { items, hasToken: Boolean(safeToken()), checkedAt: state.checkedAt || '', offline: false };
  }

  function safeToken() {
    try {
      const t = getToken();
      return typeof t === 'string' && t ? t : null;
    } catch (_) {
      return null;
    }
  }

  function newClient() {
    const token = safeToken();
    if (!token) return null;
    return createGitHubClient({ token, fetchImpl });
  }

  // The one send path, used by compose AND retry. Idempotent: the
  // remote file is checked first, so a retry after an ambiguous
  // failure (request landed, response lost) never duplicates.
  async function deliver(client, record) {
    const filePath = core.requestFilePath(record.id);
    const existing = await client.getFileText(filePath);
    if (existing !== null) return { delivered: true, alreadyThere: true };
    const content = core.buildRequestFile({
      id: record.id,
      type: record.type,
      createdAt: record.createdAt,
      machine,
      appVersion: version,
      text: record.text
    });
    await client.putFileText(filePath, content, `Ask Muse: ${record.id}`);
    return { delivered: true, alreadyThere: false };
  }

  async function attemptSend(record) {
    const client = newClient();
    if (!client) {
      record.origin = 'draft';
      record.localStatus = 'draft';
      record.lastError = '';
      return record;
    }
    try {
      await deliver(client, record);
      record.origin = 'sent';
      record.localStatus = null;
      record.lastError = '';
    } catch (err) {
      record.origin = 'draft';
      record.localStatus = 'send-failed';
      record.lastError = err.message;
    }
    return record;
  }

  return {
    // Panel view from local state only (no network): instant, and the
    // offline story — the cached statuses ride along.
    list() {
      return publicList(readLocal());
    },

    async compose({ type, text }) {
      const cleanText = typeof text === 'string' ? text : '';
      if (!cleanText.trim()) throw new Error('Write what you want first — the request box is empty.');
      const state = readLocal();
      const date = clock();
      const baseId = core.makeRequestId(date, cleanText);
      const taken = new Set(state.items.map((r) => r.id));
      const record = {
        id: core.uniqueRequestId(baseId, taken),
        type: core.isRequestType(type) ? type : 'task',
        text: cleanText,
        title: core.requestTitle(cleanText),
        createdAt: date.toISOString(),
        origin: 'draft',
        localStatus: 'draft',
        lastError: '',
        remote: null
      };
      await attemptSend(record);
      state.items.push(record);
      writeLocal(state);
      return { ok: true, request: toPublic(record, state), hasToken: Boolean(safeToken()) };
    },

    async retry(id) {
      const state = readLocal();
      const record = state.items.find((r) => r.id === id);
      if (!record) throw new Error('That request is no longer in this machine’s list.');
      if (record.origin === 'sent') return { ok: true, request: toPublic(record, state) };
      if (!safeToken()) {
        return { ok: false, error: 'Add your GitHub token in Settings to send this to Muse.', request: toPublic(record, state) };
      }
      await attemptSend(record);
      writeLocal(state);
      return { ok: record.origin === 'sent', request: toPublic(record, state) };
    },

    // Remove from THIS machine's list only. A request already in the
    // repo stays in the repo (and will reappear on the next refresh);
    // this only forgets local drafts / hides a cached row locally is
    // NOT promised — the return text in the panel says exactly that.
    removeLocal(id) {
      const state = readLocal();
      const before = state.items.length;
      state.items = state.items.filter((r) => r.id !== id);
      if (state.items.length === before) return false;
      writeLocal(state);
      return true;
    },

    // Pull the repo state: discover requests composed elsewhere,
    // read every status.md, refresh the cache. On any failure the
    // cached list is returned with offline: true — never an error.
    async refresh() {
      const state = readLocal();
      const client = newClient();
      if (!client) return { ...publicList(state), offline: false, noToken: true };
      try {
        const entries = await client.listRequestsDir();
        const fileIds = new Set();
        const statusIds = new Set();
        for (const e of entries) {
          if (e.type === 'file' && e.name.endsWith('.md')) {
            const id = e.name.slice(0, -3);
            if (core.isRequestId(id)) fileIds.add(id);
          } else if (e.type === 'dir' && core.isRequestId(e.name)) {
            statusIds.add(e.name);
          }
        }
        const byId = new Map(state.items.map((r) => [r.id, r]));
        // New requests discovered in the repo (other machine / by hand).
        for (const id of fileIds) {
          if (!byId.has(id)) {
            const rawText = await client.getFileText(core.requestFilePath(id));
            const parsed = rawText !== null ? core.parseRequestFile(rawText) : null;
            const record = {
              id,
              type: parsed ? parsed.type : 'task',
              text: parsed ? parsed.text : '',
              title: parsed ? core.requestTitle(parsed.text) : id,
              createdAt: parsed ? parsed.createdAt : '',
              origin: 'remote',
              localStatus: null,
              lastError: '',
              remote: null
            };
            state.items.push(record);
            byId.set(id, record);
          }
        }
        // Statuses: read status.md wherever a status dir exists.
        for (const id of statusIds) {
          const record = byId.get(id);
          if (!record) continue;
          const rawStatus = await client.getFileText(core.statusFilePath(id));
          const parsed = rawStatus !== null ? core.parseStatusFile(rawStatus) : null;
          record.remote = parsed;
          if (record.origin === 'remote' || record.origin === 'sent') {
            record.localStatus = null;
          }
        }
        state.checkedAt = clock().toISOString();
        writeLocal(state);
        return { ...publicList(state), offline: false };
      } catch (_) {
        return { ...publicList(state), offline: true };
      }
    }
  };
}

module.exports = { createGitHubClient, createRequestsChannel, OWNER, REPO, REQUESTS_DIR };
