'use strict';

// Transcripts library tests (v0.4.5) — the store behind the
// Transcripts panel: a job record exists BEFORE the first segment
// runs, segments land one by one, a "crash" (new store instance, same
// directory) resumes from exactly what was saved, finalize labels
// coverage honestly, and list() never leaks segment text.
// Run: node tests/transcripts.test.js

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const core = require('../src/transcribeCore');
const { createTranscriptsStore } = require('../src/transcripts');

function testLifecycle() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-transcripts-'));
  try {
    const store = createTranscriptsStore(dir);
    const plan = core.planSegments(900);
    const job = store.createJob({
      title: 'Board meeting', sourceName: 'board.mp4', sourceKind: 'teach-video',
      sourceRef: 'vid-123', model: 'large-v3-turbo', language: 'auto', durationSec: 900, plan
    });
    assert.strictEqual(job.status, 'transcribing', 'record exists before segment 1');
    assert.strictEqual(job.segmentCount, 3);
    assert.strictEqual(job.doneCount, 0);

    store.updateSegment(job.id, 0, { status: 'done', text: 'Welcome everyone.', detectedLanguage: 'en' });
    store.updateSegment(job.id, 2, { status: 'done', text: 'See you next week.' });
    store.updateSegment(job.id, 1, { status: 'failed' });

    const partial = store.finalize(job.id);
    assert.strictEqual(partial.status, 'partial');
    assert.strictEqual(partial.complete, false);
    assert.deepStrictEqual(partial.missingRanges, [{ start: 300, end: 600 }]);
    assert.strictEqual(partial.coverageLabel, 'Transcribed 10:00 of 15:00 — PARTIAL (missing 5:00–10:00)');
    assert.strictEqual(partial.detectedLanguage, 'en');
    assert.ok(partial.wordCount >= 5);
    assert.ok(partial.text.includes('(not transcribed: 5:00–10:00)'));

    // list() is metadata only — no text, no segments.
    const listed = store.list();
    assert.strictEqual(listed.length, 1);
    assert.ok(!('text' in listed[0]) && !('segments' in listed[0]), 'list() never carries transcript bodies');
    assert.strictEqual(listed[0].coverageLabel, partial.coverageLabel);

    // Retry list = exactly the unfinished segments.
    assert.deepStrictEqual(store.pendingSegments(job.id), [{ index: 1, start: 300, end: 600 }]);

    // "Crash": a fresh store over the same directory sees the job
    // exactly as saved — resumable, not lost.
    const store2 = createTranscriptsStore(dir);
    const survived = store2.get(job.id);
    assert.strictEqual(survived.status, 'partial');
    assert.strictEqual(survived.segments[0].text, 'Welcome everyone.');
    assert.deepStrictEqual(store2.pendingSegments(job.id).map((s) => s.index), [1]);

    store2.updateSegment(job.id, 1, { status: 'done', text: 'The middle part.' });
    const done = store2.finalize(job.id);
    assert.strictEqual(done.status, 'complete');
    assert.strictEqual(done.coverageLabel, 'Transcribed 15:00 of 15:00');
    assert.ok(done.text.indexOf('Welcome everyone.') < done.text.indexOf('The middle part.'),
      'stitched in media order');
    assert.ok(done.text.indexOf('The middle part.') < done.text.indexOf('See you next week.'));

    // A job where nothing landed is 'failed', with its error kept.
    const job2 = store2.createJob({
      title: 'Silent clip', sourceName: 'silent.mp4', sourceKind: 'chat-attachment',
      model: 'base', language: 'auto', durationSec: 60, plan: core.planSegments(60)
    });
    const failed = store2.finalize(job2.id, { class: 'no-audio-stream', message: 'That file has no audio track.', fix: null });
    assert.strictEqual(failed.status, 'failed');
    assert.strictEqual(failed.error.class, 'no-audio-stream');

    // An in-progress record (app closed mid-job) also finalizes
    // honestly from whatever segments exist.
    const job3 = store2.createJob({
      title: 'Interrupted', sourceName: 'long.mp4', sourceKind: 'file',
      model: 'base', language: 'es', durationSec: 600, plan: core.planSegments(600)
    });
    store2.updateSegment(job3.id, 0, { status: 'done', text: 'Primera parte.' });
    const interrupted = store2.finalize(job3.id);
    assert.strictEqual(interrupted.status, 'partial');
    assert.strictEqual(interrupted.coverageLabel, 'Transcribed 5:00 of 10:00 — PARTIAL (missing 5:00–10:00)');

    assert.strictEqual(store2.remove(job.id), true);
    assert.strictEqual(store2.get(job.id), null);
    assert.strictEqual(store2.remove(job.id), false);
    console.log('  ✓ transcripts store: lifecycle, crash-resume, honest finalize, delete');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function testCorruptLibraryFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-transcripts-corrupt-'));
  try {
    fs.writeFileSync(path.join(dir, 'transcripts.json'), '{broken json');
    const store = createTranscriptsStore(dir);
    assert.deepStrictEqual(store.list(), [], 'a corrupt library reads as empty, never a crash');
    const job = store.createJob({
      title: 'Fresh start', sourceName: 'a.wav', sourceKind: 'file',
      model: 'base', language: 'auto', durationSec: 30, plan: core.planSegments(30)
    });
    assert.ok(job.id.startsWith('tr-'));
    console.log('  ✓ transcripts store: corrupt file tolerated');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

testLifecycle();
testCorruptLibraryFile();
console.log('transcripts.test.js: ALL PASS');
