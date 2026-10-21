'use strict';

// Transcripts library (Muse Bridge v0.4.5).
//
// Every transcription — from a chat attachment or from Teach from
// video — lands here, in userData/transcripts.json, and NOWHERE else:
// transcription is local, so transcripts never leave the machine on
// their own. A transcript only leaves inside a chat message Michael
// himself sends (the staged document block) or a file he exports.
//
// Jobs are SEGMENTED (src/transcribeCore.js): a record is created
// before the first segment runs and updated as each segment lands,
// so closing the app mid-meeting never loses finished segments — the
// record stays in the library, labeled with exactly what it covers,
// and "Retry missing parts" re-runs only the gaps.
//
// A record:
//   { id, title, sourceName, sourceKind, status, model, language,
//     detectedLanguage, durationSec, coveredSec, complete,
//     missingRanges: [{start,end}], plan: [{index,start,end}],
//     segments: [{index,start,end,status,text}],
//     text, wordCount, error: {class,message,fix}|null,
//     createdAt, updatedAt }
// status: 'transcribing' | 'complete' | 'partial' | 'failed'
// list() returns metadata + coverage only — never segment texts.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const core = require('./transcribeCore');

function createTranscriptsStore(userDataPath) {
  if (typeof userDataPath !== 'string' || !userDataPath) {
    throw new Error('createTranscriptsStore requires a userData path.');
  }
  const file = path.join(userDataPath, 'transcripts.json');

  function readRaw() {
    try {
      if (fs.existsSync(file)) {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (Array.isArray(parsed)) return parsed;
      }
    } catch (_) {
      // Corrupt library file: empty library rather than a crash.
    }
    return [];
  }

  function writeRaw(records) {
    fs.mkdirSync(userDataPath, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(records, null, 2), 'utf8');
  }

  function makeId() {
    return `tr-${Date.now().toString(36)}-${crypto.randomBytes(6).toString('hex')}`;
  }

  function coverageOf(record) {
    const results = {};
    for (const seg of record.segments || []) results[seg.index] = seg.status;
    return core.computeCoverage(record.plan || [], results);
  }

  function refreshDerived(record) {
    const coverage = coverageOf(record);
    record.coveredSec = coverage.coveredSec;
    record.durationSec = coverage.totalSec || record.durationSec || 0;
    record.complete = coverage.complete;
    record.missingRanges = coverage.missingRanges;
    record.text = core.stitchTranscript({ title: record.title, segments: record.segments || [], coverage });
    record.wordCount = core.countWords(
      (record.segments || []).filter((s) => s.status === 'done').map((s) => s.text || '').join(' ')
    );
    return record;
  }

  function toPublic(record, full) {
    const pub = {
      id: record.id,
      title: record.title,
      sourceName: record.sourceName || '',
      sourceKind: record.sourceKind || 'file',
      sourceRef: record.sourceRef || '',
      status: record.status,
      model: record.model || '',
      language: record.language || 'auto',
      detectedLanguage: record.detectedLanguage || '',
      durationSec: record.durationSec || 0,
      coveredSec: record.coveredSec || 0,
      complete: Boolean(record.complete),
      missingRanges: record.missingRanges || [],
      coverageLabel: core.coverageHeader({
        coveredSec: record.coveredSec || 0,
        totalSec: record.durationSec || 0,
        complete: Boolean(record.complete),
        missingRanges: record.missingRanges || []
      }),
      segmentCount: (record.plan || []).length,
      doneCount: (record.segments || []).filter((s) => s.status === 'done').length,
      wordCount: record.wordCount || 0,
      error: record.error || null,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt
    };
    if (full) {
      pub.text = record.text || '';
      pub.segments = (record.segments || []).map((s) => ({
        index: s.index, start: s.start, end: s.end, status: s.status, text: s.text || ''
      }));
      pub.plan = record.plan || [];
    }
    return pub;
  }

  function findRecord(records, id) {
    return records.find((r) => r.id === id) || null;
  }

  function list() {
    return readRaw()
      .map((r) => toPublic(r, false))
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  }

  function get(id) {
    const record = findRecord(readRaw(), id);
    return record ? toPublic(record, true) : null;
  }

  // Create a job record BEFORE the first segment runs, so an app
  // close mid-job leaves a resumable record, not a lost meeting.
  function createJob({ title, sourceName, sourceKind, sourceRef, model, language, durationSec, plan }) {
    const now = new Date().toISOString();
    const planned = Array.isArray(plan) && plan.length ? plan : core.planSegments(durationSec);
    const record = {
      id: makeId(),
      title: typeof title === 'string' && title.trim() ? title.trim() : 'Untitled recording',
      sourceName: typeof sourceName === 'string' ? sourceName : '',
      sourceKind: sourceKind || 'file',
      sourceRef: typeof sourceRef === 'string' ? sourceRef : '',
      status: 'transcribing',
      model: model || core.DEFAULT_MODEL_ID,
      language: language || 'auto',
      detectedLanguage: '',
      durationSec: Number.isFinite(durationSec) ? durationSec : 0,
      coveredSec: 0,
      complete: false,
      missingRanges: [],
      plan: planned,
      segments: planned.map((s) => ({ index: s.index, start: s.start, end: s.end, status: 'pending', text: '' })),
      text: '',
      wordCount: 0,
      error: null,
      createdAt: now,
      updatedAt: now
    };
    refreshDerived(record);
    const records = readRaw();
    records.push(record);
    writeRaw(records);
    return toPublic(record, true);
  }

  function updateSegment(id, index, patch) {
    const records = readRaw();
    const record = findRecord(records, id);
    if (!record) throw new Error('That transcript record no longer exists.');
    const seg = (record.segments || []).find((s) => s.index === index);
    if (!seg) throw new Error('That segment no longer exists.');
    if (patch && (patch.status === 'done' || patch.status === 'failed' || patch.status === 'pending')) {
      seg.status = patch.status;
    }
    if (patch && typeof patch.text === 'string') seg.text = patch.text;
    if (patch && patch.detectedLanguage) record.detectedLanguage = patch.detectedLanguage;
    record.updatedAt = new Date().toISOString();
    refreshDerived(record);
    writeRaw(records);
    return toPublic(record, true);
  }

  // Recompute status/coverage/text from the segments as they stand.
  // Called when a job ends, is cancelled, or is interrupted: whatever
  // finished is kept and labeled honestly.
  function finalize(id, errorInfo) {
    const records = readRaw();
    const record = findRecord(records, id);
    if (!record) throw new Error('That transcript record no longer exists.');
    refreshDerived(record);
    const done = (record.segments || []).filter((s) => s.status === 'done').length;
    if (errorInfo) record.error = errorInfo;
    if (done === 0) record.status = 'failed';
    else if (record.complete) record.status = 'complete';
    else record.status = 'partial';
    record.updatedAt = new Date().toISOString();
    writeRaw(records);
    return toPublic(record, true);
  }

  // Segments that still need work — the retry/resume work list.
  function pendingSegments(id) {
    const record = findRecord(readRaw(), id);
    if (!record) return [];
    return (record.segments || [])
      .filter((s) => s.status !== 'done')
      .map((s) => ({ index: s.index, start: s.start, end: s.end }));
  }

  function setStatus(id, status) {
    const records = readRaw();
    const record = findRecord(records, id);
    if (!record) return null;
    record.status = status;
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

  return { list, get, createJob, updateSegment, finalize, pendingSegments, setStatus, remove };
}

module.exports = { createTranscriptsStore };
