'use strict';

// Ask Muse — pure core (Muse Bridge v0.4.1).
//
// The "✉️ Ask Muse" channel: Michael types a request in the app
// (a feature he wants, a skill, a task, a question), the app files it
// as a Markdown document in the `requests/` folder of the private
// Muse Bridge repo, and Muse's side works it from there (see
// docs/REQUESTS-PROTOCOL.md for the full contract). Results come back
// as `requests/<id>/status.md` files written by Muse's side; shipped
// features arrive as ordinary app updates.
//
// This module is the shared, environment-agnostic core: it runs in the
// browser renderer (classic script, window.MuseRequestsCore) AND under
// bare node (module.exports) for the main-process channel and the unit
// tests. It never touches the DOM, the filesystem, or the network.

(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.MuseRequestsCore = api;
  }
})(typeof window !== 'undefined' ? window : null, function () {
  // ---- Vocabulary (docs/REQUESTS-PROTOCOL.md is the contract) ----

  const REQUEST_TYPES = ['feature', 'skill', 'task', 'question'];
  const TYPE_LABELS = {
    feature: 'App feature',
    skill: 'New skill',
    task: 'Task for Muse',
    question: 'Question'
  };

  // The full status vocabulary. 'draft' and 'send-failed' are LOCAL
  // states (the request never left this PC, or its send failed); the
  // rest are read from the repo: 'sent' means the file is in the repo
  // with no status.md yet; 'seen' / 'building' / 'shipped' /
  // 'answered' are written by Muse's side into status.md.
  const REQUEST_STATUSES = ['draft', 'send-failed', 'sent', 'seen', 'building', 'shipped', 'answered'];
  const STATUS_LABELS = {
    draft: 'Draft — not sent yet',
    'send-failed': 'Send failed — retry',
    sent: 'Sent to Muse',
    seen: 'Seen by Muse',
    building: 'Muse is building it',
    shipped: 'Shipped',
    answered: 'Answered'
  };

  function isRequestType(value) {
    return REQUEST_TYPES.includes(value);
  }

  function isRequestStatus(value) {
    return REQUEST_STATUSES.includes(value);
  }

  function statusLabel(status, statusInfo) {
    if (status === 'shipped' && statusInfo && statusInfo.version) {
      return `Shipped in v${String(statusInfo.version).replace(/^v/i, '')}`;
    }
    return STATUS_LABELS[status] || status;
  }

  // ---- Ids ----
  // REQ-<yyyymmdd>-<hhmmss>-<slug> in America/New_York time, so an id
  // reads the way Michael's clock read when he sent the request.

  const ET_ZONE = 'America/New_York';

  function etParts(date) {
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone: ET_ZONE,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hourCycle: 'h23'
    });
    const parts = {};
    for (const p of dtf.formatToParts(date)) {
      if (p.type !== 'literal') parts[p.type] = p.value;
    }
    return parts;
  }

  function slugify(text, maxLen) {
    const limit = Number.isFinite(maxLen) && maxLen > 0 ? maxLen : 40;
    const slug = String(text || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, limit)
      .replace(/-+$/g, '');
    return slug || 'request';
  }

  // The title of a request = the first non-empty line of the text.
  function requestTitle(text) {
    const line = String(text || '').split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0) || '';
    return line.length > 80 ? `${line.slice(0, 77)}…` : line;
  }

  function makeRequestId(date, text) {
    const p = etParts(date);
    return `REQ-${p.year}${p.month}${p.day}-${p.hour}${p.minute}${p.second}-${slugify(requestTitle(text))}`;
  }

  const REQUEST_ID_RE = /^REQ-\d{8}-\d{6}-[a-z0-9]+(?:-[a-z0-9]+)*$/;

  function isRequestId(value) {
    return typeof value === 'string' && REQUEST_ID_RE.test(value);
  }

  // Collision handling: the same second + same first line can recur
  // (a re-send, a double click). Suffix -2, -3, … until the name is
  // free. `taken` is a Set/array of ids already in use.
  function uniqueRequestId(baseId, taken) {
    const set = taken instanceof Set ? taken : new Set(taken || []);
    if (!set.has(baseId)) return baseId;
    for (let n = 2; n < 1000; n++) {
      const candidate = `${baseId}-${n}`;
      if (!set.has(candidate)) return candidate;
    }
    return `${baseId}-${Date.now().toString(36)}`;
  }

  function requestFilePath(id) {
    return `requests/${id}.md`;
  }

  function statusFilePath(id) {
    return `requests/${id}/status.md`;
  }

  // ---- Request file format ----
  // A header block of "key: value" lines, a line containing only
  // "---", then Michael's text VERBATIM (no additions, no telemetry).

  function buildRequestFile({ id, type, createdAt, machine, appVersion, text }) {
    const header = [
      `id: ${id}`,
      `created: ${createdAt}`,
      `machine: ${machine || ''}`,
      `app: ${appVersion || ''}`,
      `type: ${isRequestType(type) ? type : 'task'}`,
      'status: new'
    ].join('\n');
    return `${header}\n---\n${String(text || '')}`;
  }

  function parseRequestFile(content) {
    if (typeof content !== 'string') return null;
    const match = /^([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(content);
    if (!match) return null;
    const meta = {};
    for (const line of match[1].split(/\r?\n/)) {
      const kv = /^([a-z]+):\s?(.*)$/.exec(line);
      if (kv) meta[kv[1]] = kv[2];
    }
    if (!isRequestId(meta.id)) return null;
    return {
      id: meta.id,
      createdAt: meta.created || '',
      machine: meta.machine || '',
      appVersion: meta.app || '',
      type: isRequestType(meta.type) ? meta.type : 'task',
      repoStatus: meta.status || 'new',
      text: match[2]
    };
  }

  // ---- Status file format (written by Muse's side only) ----
  // "status: <word>" first; optional "version: <x.y.z>"; optional
  // "updated: <ISO>"; a "---" line; then a free-text note (for an
  // answered question, the note IS the answer or points to the chat).

  function parseStatusFile(content) {
    if (typeof content !== 'string' || !content.trim()) return null;
    const split = /^([\s\S]*?)(?:\r?\n---\r?\n([\s\S]*))?$/.exec(content);
    if (!split) return null;
    const meta = {};
    for (const line of split[1].split(/\r?\n/)) {
      const kv = /^([a-z]+):\s?(.*)$/.exec(line);
      if (kv) meta[kv[1]] = kv[2];
    }
    if (!isRequestStatus(meta.status)) return null;
    // 'draft' / 'send-failed' are local-only states; a status.md that
    // claims them is not Muse's side talking — ignore it.
    if (meta.status === 'draft' || meta.status === 'send-failed') return null;
    return {
      status: meta.status,
      version: meta.version || '',
      updated: meta.updated || '',
      note: (split[2] || '').trim()
    };
  }

  return {
    REQUEST_TYPES,
    TYPE_LABELS,
    REQUEST_STATUSES,
    STATUS_LABELS,
    isRequestType,
    isRequestStatus,
    statusLabel,
    etParts,
    slugify,
    requestTitle,
    makeRequestId,
    isRequestId,
    uniqueRequestId,
    requestFilePath,
    statusFilePath,
    buildRequestFile,
    parseRequestFile,
    parseStatusFile
  };
});
