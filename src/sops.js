'use strict';

// SOP library store + Vimeo API helpers (Muse Bridge v0.4.0).
//
// Records live locally ONLY, in userData/sops.json:
//   { id, title, sourceKind: 'vimeo'|'file', sourceLabel, sourceUrl,
//     thumbnailUrl, durationSec, stagedId, status: 'intake'|'generated',
//     note, transcriptSource, transcriptText, frameCount, sop, markdown,
//     createdAt, updatedAt }
// Status 'intake' means we hold the link/file + metadata only — the
// recording itself has not been analyzed (no frames, possibly no
// transcript). Generation (main.js) fills in sop + markdown and flips
// the status. list() never returns transcript text (it can be long);
// get() returns the full record for the owner.
//
// Vimeo access: oEmbed is public (no token). Captions and downloadable
// files need Michael's own Vimeo access token (Settings; stored
// encrypted alongside the API key, userData only). Every helper takes
// an injected fetch so tests run on fixtures with zero network.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const core = require('./sopCore');

const MAX_TRANSCRIPT_CHARS = 300000;

function createSopsStore(userDataPath) {
  if (typeof userDataPath !== 'string' || !userDataPath) {
    throw new Error('createSopsStore requires a userData path.');
  }
  const sopsFile = path.join(userDataPath, 'sops.json');

  function readRaw() {
    try {
      if (fs.existsSync(sopsFile)) {
        const parsed = JSON.parse(fs.readFileSync(sopsFile, 'utf8'));
        if (Array.isArray(parsed)) return parsed;
      }
    } catch (_) {
      // Corrupt file: empty library rather than a crash.
    }
    return [];
  }

  function writeRaw(records) {
    fs.mkdirSync(userDataPath, { recursive: true });
    fs.writeFileSync(sopsFile, JSON.stringify(records, null, 2), 'utf8');
  }

  function makeId() {
    return `sop-${Date.now().toString(36)}-${crypto.randomBytes(6).toString('hex')}`;
  }

  function toPublic(record, full) {
    const pub = {
      id: record.id,
      title: record.title,
      sourceKind: record.sourceKind,
      sourceLabel: record.sourceLabel,
      sourceUrl: record.sourceUrl || '',
      thumbnailUrl: record.thumbnailUrl || '',
      durationSec: record.durationSec != null ? record.durationSec : null,
      stagedId: record.stagedId || '',
      status: record.status,
      note: record.note || '',
      transcriptSource: record.transcriptSource || 'none',
      hasTranscript: Boolean(record.transcriptText),
      frameCount: record.frameCount || 0,
      sop: record.sop || null,
      markdown: record.markdown || '',
      createdAt: record.createdAt,
      updatedAt: record.updatedAt
    };
    if (full) pub.transcriptText = record.transcriptText || '';
    return pub;
  }

  function list() {
    return readRaw().map((r) => toPublic(r, false));
  }

  function get(id) {
    const record = readRaw().find((r) => r.id === id);
    return record ? toPublic(record, true) : null;
  }

  function createIntake(data) {
    if (!data || (data.sourceKind !== 'vimeo' && data.sourceKind !== 'file')) {
      throw new Error('A video intake needs a source: a Vimeo link or a video file.');
    }
    const now = new Date().toISOString();
    const record = {
      id: makeId(),
      title: typeof data.title === 'string' && data.title.trim() ? data.title.trim() : 'Untitled recording',
      sourceKind: data.sourceKind,
      sourceLabel: typeof data.sourceLabel === 'string' ? data.sourceLabel : '',
      sourceUrl: typeof data.sourceUrl === 'string' ? data.sourceUrl : '',
      thumbnailUrl: typeof data.thumbnailUrl === 'string' ? data.thumbnailUrl : '',
      durationSec: Number.isFinite(data.durationSec) ? data.durationSec : null,
      stagedId: typeof data.stagedId === 'string' ? data.stagedId : '',
      status: 'intake',
      note: typeof data.note === 'string' ? data.note : '',
      transcriptSource: 'none',
      transcriptText: '',
      frameCount: 0,
      sop: null,
      markdown: '',
      createdAt: now,
      updatedAt: now
    };
    const records = readRaw();
    records.push(record);
    writeRaw(records);
    return toPublic(record, false);
  }

  const PATCHABLE = ['title', 'note', 'stagedId', 'durationSec', 'thumbnailUrl', 'status', 'frameCount'];
  function update(id, patch) {
    const records = readRaw();
    const idx = records.findIndex((r) => r.id === id);
    if (idx === -1) throw new Error('That SOP record no longer exists.');
    const record = records[idx];
    for (const key of PATCHABLE) {
      if (patch && patch[key] !== undefined) record[key] = patch[key];
    }
    if (patch && typeof patch.transcriptText === 'string') {
      record.transcriptText = patch.transcriptText.slice(0, MAX_TRANSCRIPT_CHARS);
      record.transcriptSource = patch.transcriptSource || record.transcriptSource || 'user-file';
    }
    if (patch && patch.sop) {
      record.sop = patch.sop;
      record.status = 'generated';
      record.markdown = core.sopToMarkdown({
        title: record.title,
        sop: patch.sop,
        sourceLabel: record.sourceLabel,
        transcriptSource: record.transcriptSource,
        frameCount: record.frameCount,
        createdAt: record.createdAt
      });
    }
    record.updatedAt = new Date().toISOString();
    writeRaw(records);
    return toPublic(record, false);
  }

  function remove(id) {
    const records = readRaw();
    const idx = records.findIndex((r) => r.id === id);
    if (idx === -1) return false;
    records.splice(idx, 1);
    writeRaw(records);
    return true;
  }

  return { list, get, createIntake, update, remove };
}

// ---- Vimeo network helpers (fetch injected; default = global fetch) ----

async function fetchVimeoOEmbed(pageUrl, fetchImpl) {
  const doFetch = fetchImpl || fetch;
  const endpoint = `https://vimeo.com/api/oembed.json?url=${encodeURIComponent(pageUrl)}`;
  const res = await doFetch(endpoint);
  if (!res.ok) throw new Error(`Vimeo could not read that link (HTTP ${res.status}). Check the URL and that the video is public or unlisted.`);
  const parsed = core.parseOEmbed(await res.json());
  if (!parsed) throw new Error('Vimeo returned metadata in an unexpected shape.');
  return parsed;
}

function vimeoApiHeaders(token) {
  return { Authorization: `bearer ${token}`, Accept: 'application/vnd.vimeo.*+json;version=3.4' };
}

async function fetchVimeoVideo(videoId, token, fetchImpl) {
  const doFetch = fetchImpl || fetch;
  const res = await doFetch(`https://api.vimeo.com/videos/${encodeURIComponent(videoId)}`, {
    headers: vimeoApiHeaders(token)
  });
  if (!res.ok) throw new Error(`Vimeo API rejected the video lookup (HTTP ${res.status}). The token may lack scope for this video.`);
  return res.json();
}

async function fetchVimeoTranscript(videoId, token, fetchImpl) {
  const doFetch = fetchImpl || fetch;
  const res = await doFetch(`https://api.vimeo.com/videos/${encodeURIComponent(videoId)}/texttracks`, {
    headers: vimeoApiHeaders(token)
  });
  if (!res.ok) return null;
  const track = core.pickTextTrack(await res.json());
  if (!track) return null;
  const vttRes = await doFetch(track.link);
  if (!vttRes.ok) return null;
  const text = core.vttToText(await vttRes.text());
  if (!text) return null;
  return { text, language: track.language || '' };
}

// Deterministic placeholder SOP for Mock mode: built from whatever the
// user actually provided (transcript sentences / frame count), clearly
// labeled as mock — never presented as a real analysis.
function mockSop({ title, transcriptText, frameCount }) {
  const sentences = typeof transcriptText === 'string'
    ? transcriptText.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter((s) => s.length >= 8).slice(0, 8)
    : [];
  const steps = sentences.length
    ? sentences.map((s) => ({ action: s, detail: '', expected: '' }))
    : [
        { action: 'Open the app or website shown at the start of the recording.', detail: '', expected: '' },
        { action: 'Follow the on-screen flow in the order the recording shows it.', detail: '', expected: '' },
        { action: 'Confirm the final state matches the end of the recording.', detail: '', expected: '' }
      ];
  return {
    title: title || 'Video SOP',
    goal: '[Mock mode — add your Meta Model API key in Settings for a real analysis of this recording.]',
    needs: ['The app or website shown in the recording, open and signed in'],
    steps,
    watchOuts: [
      `Mock mode cannot see the recording (${frameCount || 0} frame(s) sampled, transcript ${sentences.length ? 'used for placeholder steps' : 'not available'}). These steps are placeholders until a live key analyzes the frames.`
    ]
  };
}

module.exports = {
  createSopsStore,
  fetchVimeoOEmbed,
  fetchVimeoVideo,
  fetchVimeoTranscript,
  mockSop,
  MAX_TRANSCRIPT_CHARS
};
