'use strict';

// Local transcription tests (v0.4.5) — the pure core (model registry,
// segment planner, argv builders, parsers, coverage/stitch, failure
// translation) plus the engine end-to-end against FAKE ffmpeg/whisper
// child processes: segment saving, partial labeling, retry-only-failed,
// cancel-keeps-finished-parts, temp WAV lifecycle, readiness probes per
// failure class, and the hash-verified model download. No real media,
// no network, no Windows binaries are executed. Real-speech accuracy
// is NOT claimable from these tests — they prove mechanics only.
// Run: node tests/transcribe.test.js

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const core = require('../src/transcribeCore');
const { createTranscriber, TranscribeError, RUNTIME_FILES } = require('../src/transcriber');
const { createTranscriptsStore } = require('../src/transcripts');

const REPO_ROOT = path.join(__dirname, '..');

// ---------- core: models ----------

function testModelRegistry() {
  for (const id of ['base', 'small', 'large-v3-turbo']) {
    const m = core.getModel(id);
    assert.ok(m, `model ${id} registered`);
    assert.match(m.url, /^https:\/\/huggingface\.co\/ggerganov\/whisper\.cpp\/resolve\/main\//);
    assert.match(m.sha256, /^[0-9a-f]{64}$/);
    assert.ok(!/\.en\.bin$/.test(m.file), `${id} must be multilingual, never .en-only`);
    assert.ok(m.size > 0);
  }
  assert.strictEqual(core.getModel('base').size, 147951465);
  assert.strictEqual(core.getModel('large-v3-turbo').size, 1624555275);
  assert.strictEqual(core.MEETING_MODEL_ID, 'large-v3-turbo');
  assert.strictEqual(core.modelForSettings('nonsense'), 'base', 'unknown setting falls back to base');
  assert.strictEqual(core.modelForSettings('small'), 'small');
  console.log('  ✓ model registry (multilingual, pinned sizes + hashes)');
}

// ---------- core: segment planner ----------

function testPlanSegments() {
  // The spec's meeting: 62:10 = 3730 s -> 12 full chunks + a 130 s tail.
  const plan = core.planSegments(3730);
  assert.strictEqual(plan.length, 13);
  assert.deepStrictEqual(plan[0], { index: 0, start: 0, end: 300 });
  assert.deepStrictEqual(plan[12], { index: 12, start: 3600, end: 3730 });
  // Exact multiple: no phantom empty tail segment.
  assert.strictEqual(core.planSegments(600).length, 2);
  assert.strictEqual(core.planSegments(300).length, 1);
  // Sub-segment recording: one short segment.
  assert.deepStrictEqual(core.planSegments(42), [{ index: 0, start: 0, end: 42 }]);
  // Unknown duration -> one open-ended segment.
  assert.deepStrictEqual(core.planSegments(null), [{ index: 0, start: 0, end: null }]);
  assert.deepStrictEqual(core.planSegments(0), [{ index: 0, start: 0, end: null }]);
  assert.deepStrictEqual(core.planSegments(NaN), [{ index: 0, start: 0, end: null }]);
  // Custom chunk size honored.
  assert.strictEqual(core.planSegments(100, 30).length, 4);
  console.log('  ✓ segment planner (62:10 -> 13 chunks, remainder, unknown duration)');
}

// ---------- core: argv builders ----------

function testArgvBuilders() {
  assert.deepStrictEqual(core.buildFfmpegProbeArgs('/media/a.mp4'), ['-hide_banner', '-i', '/media/a.mp4']);
  const extract = core.buildExtractArgs('/media/a.mp4', { index: 1, start: 300, end: 600 }, '/tmp/seg-1.wav');
  const ssAt = extract.indexOf('-ss');
  const iAt = extract.indexOf('-i');
  assert.ok(ssAt > iAt, '-ss sits AFTER -i (sample-accurate segment boundaries)');
  assert.strictEqual(extract[ssAt + 1], '300');
  assert.strictEqual(extract[extract.indexOf('-t') + 1], '300');
  assert.deepStrictEqual(extract.slice(-6), ['-vn', '-ac', '1', '-ar', '16000', '/tmp/seg-1.wav']);
  const firstSeg = core.buildExtractArgs('/media/a.mp4', { index: 0, start: 0, end: 300 }, '/tmp/seg-0.wav');
  assert.ok(!firstSeg.includes('-ss'), 'no seek for the first segment');
  const openEnded = core.buildExtractArgs('/media/a.mp4', { index: 0, start: 0, end: null }, '/tmp/seg-0.wav');
  assert.ok(!openEnded.includes('-t'), 'open-ended segment has no -t cap');

  const w = core.buildWhisperArgs({ modelPath: '/m/ggml-base.bin', wavPath: '/tmp/s.wav', outBase: '/tmp/s', language: 'es' });
  assert.deepStrictEqual(w.slice(0, 5), ['-m', '/m/ggml-base.bin', '-f', '/tmp/s.wav', '-l']);
  assert.strictEqual(w[5], 'es');
  for (const flag of ['-otxt', '-ojf', '-nt', '-pp']) assert.ok(w.includes(flag), `whisper args include ${flag}`);
  const auto = core.buildWhisperArgs({ modelPath: '/m', wavPath: '/w', outBase: '/o', language: 'klingon' });
  assert.strictEqual(auto[5], 'auto', 'unsupported language falls back to auto-detect');
  console.log('  ✓ argv builders (extract -ss after -i, whisper flags, language)');
}

// ---------- core: parsers ----------

const PROBE_WITH_AUDIO = [
  "Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'meeting.mp4':",
  '  Duration: 01:02:10.44, start: 0.000000, bitrate: 812 kb/s',
  '    Stream #0:0[0x1](und): Video: h264 (High) (avc1 / 0x31637661), 1920x1080, 30 fps',
  '    Stream #0:1[0x2](und): Audio: aac (LC) (mp4a / 0x6134706D), 44100 Hz, stereo'
].join('\n');
const PROBE_NO_AUDIO = [
  "Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'silent.mp4':",
  '  Duration: 00:00:30.00, start: 0.000000, bitrate: 500 kb/s',
  '    Stream #0:0[0x1](und): Video: h264 (High), 1280x720, 30 fps'
].join('\n');

function testParsers() {
  const probe = core.parseFfmpegProbe(PROBE_WITH_AUDIO);
  assert.strictEqual(Math.round(probe.durationSec), 3730);
  assert.strictEqual(probe.hasAudio, true);
  const noAudio = core.parseFfmpegProbe(PROBE_NO_AUDIO);
  assert.strictEqual(noAudio.durationSec, 30);
  assert.strictEqual(noAudio.hasAudio, false);
  assert.deepStrictEqual(core.parseFfmpegProbe('total garbage'), { durationSec: null, hasAudio: false });

  const parsed = core.parseWhisperJson(JSON.stringify({
    result: { language: 'es' },
    transcription: [
      { offsets: { from: 0, to: 5000 }, text: ' Hola a todos. ' },
      { offsets: { from: 5000, to: 9000 }, text: 'Empezamos.' }
    ]
  }));
  assert.strictEqual(parsed.language, 'es');
  assert.strictEqual(parsed.text, 'Hola a todos. Empezamos.');
  assert.deepStrictEqual(parsed.segments[1], { start: 5, end: 9, text: 'Empezamos.' });
  assert.strictEqual(core.parseWhisperJson('not json'), null);
  assert.strictEqual(core.parseWhisperJson(''), null);
  assert.strictEqual(core.parseWhisperProgress('whisper_print_progress_callback: progress =  37%'), 37);
  assert.strictEqual(core.parseWhisperProgress('unrelated line'), null);
  console.log('  ✓ parsers (ffmpeg probe, whisper JSON, progress lines)');
}

// ---------- core: coverage + stitch ----------

function testCoverageAndStitch() {
  const plan = core.planSegments(3730);
  const allDone = {};
  for (const s of plan) allDone[s.index] = 'done';
  const full = core.computeCoverage(plan, allDone);
  assert.strictEqual(full.complete, true);
  assert.strictEqual(core.coverageHeader(full), 'Transcribed 62:10 of 62:10');

  // Segments 4+5 failed -> ONE merged gap, named exactly.
  const results = { ...allDone };
  results[4] = 'failed';
  results[5] = 'failed';
  results[9] = 'pending';
  const partial = core.computeCoverage(plan, results);
  assert.strictEqual(partial.complete, false);
  assert.deepStrictEqual(partial.missingRanges, [
    { start: 1200, end: 1800 },
    { start: 2700, end: 3000 }
  ]);
  assert.strictEqual(
    core.coverageHeader(partial),
    'Transcribed 47:10 of 62:10 — PARTIAL (missing 20:00–30:00; missing 45:00–50:00)'
  );

  const stitched = core.stitchTranscript({
    title: 'Weekly sync',
    coverage: partial,
    segments: [
      { index: 1, start: 300, end: 600, status: 'done', text: 'Second chunk words.' },
      { index: 0, start: 0, end: 300, status: 'done', text: 'First chunk words.' },
      { index: 4, start: 1200, end: 1500, status: 'failed', text: '' }
    ]
  });
  assert.ok(stitched.startsWith('Transcript: Weekly sync\nTranscribed 47:10 of 62:10 — PARTIAL'));
  assert.ok(stitched.indexOf('[0:00]') < stitched.indexOf('[5:00]'), 'segments stitched in media order, not completion order');
  assert.ok(stitched.includes('(not transcribed: 20:00–25:00)'), 'gap line names the missing range');
  console.log('  ✓ coverage math + stitch (merged gaps, exact ranges, ordered)');
}

// ---------- core: failure translation ----------

function testClassify() {
  const enoent = Object.assign(new Error('spawn whisper ENOENT'), { code: 'ENOENT' });
  let info = core.classifyToolError({ tool: 'whisper', spawnError: enoent });
  assert.strictEqual(info.class, 'tool-missing');
  assert.strictEqual(info.fix, 'repair-binaries');

  info = core.classifyToolError({ tool: 'whisper', code: -1073741515, stderr: 'The code execution cannot proceed because MSVCP140.dll was not found.' });
  assert.strictEqual(info.class, 'missing-dll');
  assert.strictEqual(info.fix, 'repair-binaries');
  assert.match(info.message, /runtime DLL/);

  info = core.classifyToolError({ tool: 'whisper', code: -1073741795, stderr: '0xc000007b' });
  assert.strictEqual(info.class, 'bad-architecture');

  info = core.classifyToolError({ tool: 'whisper', code: 1, stderr: 'error: failed to load model' });
  assert.strictEqual(info.class, 'model-load');
  assert.strictEqual(info.fix, 'redownload-model');

  info = core.classifyToolError({ tool: 'ffmpeg', code: 1, stderr: 'Output file is empty, nothing was encoded (matches no streams)' });
  assert.strictEqual(info.class, 'no-audio-stream');
  assert.strictEqual(info.fix, null);

  info = core.classifyToolError({ tool: 'ffmpeg', code: 1, stderr: 'moov atom not found / Invalid data found when processing input' });
  assert.strictEqual(info.class, 'unsupported-media');
  assert.strictEqual(info.fix, 'pick-another-file');

  info = core.classifyToolError({ tool: 'whisper', code: 3, stderr: 'something opaque' });
  assert.strictEqual(info.class, 'unknown');
  assert.match(info.message, /exit code 3/);

  const missing = core.modelMissingError(core.getModel('base'));
  assert.strictEqual(missing.class, 'model-missing');
  assert.strictEqual(missing.fix, 'redownload-model');
  assert.match(missing.message, /~150 MB/);
  console.log('  ✓ failure translation (each class -> plain message + fix)');
}

// ---------- engine fakes ----------

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {
    setImmediate(() => child.emit('close', null, 'SIGTERM'));
    return true;
  };
  return child;
}

function closeWith(child, { stdout = '', stderr = '', code = 0 } = {}) {
  setImmediate(() => {
    if (stdout) child.stdout.emit('data', Buffer.from(stdout));
    if (stderr) child.stderr.emit('data', Buffer.from(stderr));
    child.emit('close', code);
  });
}

// A fake ffmpeg + whisper pair. opts:
//   durationSec, hasAudio, failSegments (Set), hangSegment (index),
//   probeError (spawn error to throw), whisperStderr (per-run override)
function makeFakeEngine(opts = {}) {
  const calls = [];
  const spawnImpl = (cmd, args) => {
    const child = fakeChild();
    const base = path.basename(cmd);
    calls.push({ tool: base, args: [...args] });
    if (base === 'ffmpeg.exe') {
      if (args.includes('-version')) {
        closeWith(child, { stdout: 'ffmpeg version 6.1.1 Copyright (c) 2000-2023\n', code: 0 });
        return child;
      }
      if (!args.includes('-vn')) {
        // Probe: `ffmpeg -i` exits 1 by design; stderr carries the facts.
        if (opts.probeError) {
          setImmediate(() => child.emit('error', opts.probeError));
          return child;
        }
        const dur = opts.durationSec != null ? opts.durationSec : 600;
        const hh = String(Math.floor(dur / 3600)).padStart(2, '0');
        const mm = String(Math.floor((dur % 3600) / 60)).padStart(2, '0');
        const ss = String(Math.floor(dur % 60)).padStart(2, '0');
        const lines = [
          "Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'input':",
          `  Duration: ${hh}:${mm}:${ss}.00, start: 0.000000, bitrate: 800 kb/s`,
          '    Stream #0:0[0x1](und): Video: h264 (High), 1280x720, 30 fps'
        ];
        if (opts.hasAudio !== false) lines.push('    Stream #0:1[0x2](und): Audio: aac (LC), 44100 Hz, stereo');
        closeWith(child, { stderr: lines.join('\n'), code: 1 });
        return child;
      }
      // Extract: write the WAV the transcriber expects.
      fs.writeFileSync(args[args.length - 1], Buffer.from('RIFF-fake-wav'));
      closeWith(child, { code: 0 });
      return child;
    }
    if (base === 'whisper-cli.exe') {
      if (args.includes('--help')) {
        if (opts.whisperHelpError) {
          setImmediate(() => child.emit('error', opts.whisperHelpError));
          return child;
        }
        if (opts.whisperHelpStderr != null) {
          closeWith(child, { stderr: opts.whisperHelpStderr, code: opts.whisperHelpCode != null ? opts.whisperHelpCode : 1 });
          return child;
        }
        closeWith(child, { stdout: 'Usage: whisper-cli [options] file0 ...\n', code: 0 });
        return child;
      }
      const wavPath = args[args.indexOf('-f') + 1];
      const segIndex = parseInt(/seg-(\d+)\.wav$/.exec(wavPath)[1], 10);
      if (opts.hangSegment === segIndex) {
        return child; // never closes; only kill() ends it
      }
      const outBase = args[args.indexOf('-of') + 1];
      if (opts.failSegments && opts.failSegments.has(segIndex)) {
        closeWith(child, { stderr: `whisper exploded on segment ${segIndex}`, code: 1 });
        return child;
      }
      const text = `Words from segment ${segIndex}.`;
      fs.writeFileSync(`${outBase}.txt`, `${text}\n`);
      fs.writeFileSync(`${outBase}.json`, JSON.stringify({
        result: { language: 'en' },
        transcription: [{ offsets: { from: 0, to: 5000 }, text: ` ${text}` }]
      }));
      setImmediate(() => {
        child.stderr.emit('data', Buffer.from('whisper_print_progress_callback: progress =  55%\n'));
        child.emit('close', 0);
      });
      return child;
    }
    closeWith(child, { code: 0 });
    return child;
  };
  return { spawnImpl, calls };
}

const FIXTURE_MODEL_CONTENT = Buffer.from('FAKE-WHISPER-MODEL-FOR-TESTS');
const FIXTURE_MODEL = {
  id: 'base',
  file: 'ggml-base.bin',
  label: 'Fast',
  blurb: 'fixture',
  size: FIXTURE_MODEL_CONTENT.length,
  sizeLabel: '~150 MB',
  sha256: crypto.createHash('sha256').update(FIXTURE_MODEL_CONTENT).digest('hex'),
  url: 'https://example.invalid/ggml-base.bin'
};

function makeRig(engineOpts) {
  // Rigs live under the home dir, not os.tmpdir(): /tmp can be a small
  // tmpfs, and the readiness disk-space check (correctly) fails there.
  const dir = fs.mkdtempSync(path.join(os.homedir(), 'mb-transcribe-'));
  const userData = path.join(dir, 'userData');
  const resources = path.join(dir, 'resources');
  fs.mkdirSync(resources, { recursive: true });
  for (const name of RUNTIME_FILES) fs.writeFileSync(path.join(resources, name), Buffer.from('x'));
  const store = createTranscriptsStore(userData);
  const engine = makeFakeEngine(engineOpts);
  const transcriber = createTranscriber({
    userDataPath: userData,
    resourcesBinDir: resources,
    store,
    spawnImpl: engine.spawnImpl,
    fetchImpl: null,
    getModel: (id) => (id === 'base' ? FIXTURE_MODEL : null),
    modelIds: ['base']
  });
  const mediaFile = path.join(dir, 'meeting.mp4');
  fs.writeFileSync(mediaFile, Buffer.from('fake-media'));
  return { dir, userData, resources, store, engine, transcriber, mediaFile };
}

function placeModel(rig, content) {
  const modelsDir = path.join(rig.userData, 'models');
  fs.mkdirSync(modelsDir, { recursive: true });
  fs.writeFileSync(path.join(modelsDir, 'ggml-base.bin'), content || FIXTURE_MODEL_CONTENT);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function testEngineFullRun() {
  const rig = makeRig({ durationSec: 600 });
  try {
    placeModel(rig);
    const progress = [];
    const record = await rig.transcriber.transcribe({
      inputPath: rig.mediaFile, title: 'Weekly sync', sourceKind: 'chat-attachment',
      modelId: 'base', language: 'auto', onProgress: (p) => progress.push(p)
    });
    assert.strictEqual(record.status, 'complete');
    assert.strictEqual(record.coverageLabel, 'Transcribed 10:00 of 10:00');
    const full = rig.store.get(record.id);
    assert.ok(full.text.includes('Words from segment 0.'));
    assert.ok(full.text.includes('Words from segment 1.'));
    assert.ok(full.text.includes('[0:00]') && full.text.includes('[5:00]'));
    assert.strictEqual(full.detectedLanguage, 'en');
    assert.ok(full.wordCount >= 8);
    assert.ok(progress.some((p) => p.phase === 'segment' && p.segmentNumber === 2 && p.segmentCount === 2), 'progress marches segment by segment');
    // Temp WAV lifecycle: the per-job temp dir is gone entirely.
    const tmpRoot = path.join(rig.userData, 'transcribe-tmp');
    assert.deepStrictEqual(fs.existsSync(tmpRoot) ? fs.readdirSync(tmpRoot) : [], [], 'no temp files survive a run');
    console.log('  ✓ engine: full 2-segment run, stitched + cleaned up');
  } finally {
    fs.rmSync(rig.dir, { recursive: true, force: true });
  }
}

async function testEnginePartialAndRetry() {
  const rig = makeRig({ durationSec: 900, failSegments: new Set([1]) });
  try {
    placeModel(rig);
    const record = await rig.transcriber.transcribe({
      inputPath: rig.mediaFile, title: 'Long meeting', modelId: 'base', language: 'auto'
    });
    assert.strictEqual(record.status, 'partial', 'one failed segment -> PARTIAL, never silent');
    assert.deepStrictEqual(record.missingRanges, [{ start: 300, end: 600 }]);
    assert.strictEqual(record.coverageLabel, 'Transcribed 10:00 of 15:00 — PARTIAL (missing 5:00–10:00)');
    const full = rig.store.get(record.id);
    assert.ok(full.text.includes('(not transcribed: 5:00–10:00)'));
    assert.deepStrictEqual(rig.store.pendingSegments(record.id).map((s) => s.index), [1]);

    // Retry ONLY the failed segment: whisper must run exactly once more.
    rig.engine.calls.length = 0;
    const retried = await rig.transcriber.transcribe({
      inputPath: rig.mediaFile, title: 'Long meeting', modelId: 'base', language: 'auto',
      recordId: record.id, onlySegments: [1]
    });
    // The fake still fails segment 1 (its fail set is unchanged) — flip it off and retry again.
    assert.strictEqual(retried.status, 'partial');
    const whisperRuns = rig.engine.calls.filter((c) => c.tool === 'whisper-cli.exe' && !c.args.includes('--help'));
    assert.strictEqual(whisperRuns.length, 1, 'retry re-runs ONLY the missing segment');
    rig.engine.calls.length = 0;
    // A fresh engine with no failures completes the record.
    const fixed = makeFakeEngine({ durationSec: 900 });
    const rig2Engine = fixed.spawnImpl;
    const transcriber2 = createTranscriber({
      userDataPath: rig.userData, resourcesBinDir: rig.resources, store: rig.store,
      spawnImpl: rig2Engine, fetchImpl: null,
      getModel: (id) => (id === 'base' ? FIXTURE_MODEL : null), modelIds: ['base']
    });
    const done = await transcriber2.transcribe({
      inputPath: rig.mediaFile, title: 'Long meeting', modelId: 'base', language: 'auto',
      recordId: record.id, onlySegments: rig.store.pendingSegments(record.id).map((s) => s.index)
    });
    assert.strictEqual(done.status, 'complete');
    assert.strictEqual(done.coverageLabel, 'Transcribed 15:00 of 15:00');
    console.log('  ✓ engine: PARTIAL labeling, exact missing range, retry-only-failed');
  } finally {
    fs.rmSync(rig.dir, { recursive: true, force: true });
  }
}

async function testEngineCancelKeepsParts() {
  const rig = makeRig({ durationSec: 600, hangSegment: 1 });
  try {
    placeModel(rig);
    let recordId = null;
    const promise = rig.transcriber.transcribe({
      inputPath: rig.mediaFile, title: 'Cancel me', modelId: 'base', language: 'auto',
      onProgress: (p) => { if (p.recordId) recordId = p.recordId; }
    });
    // Wait until segment 0 has landed in the store and segment 1 is hanging.
    for (let i = 0; i < 200 && !(recordId && rig.store.get(recordId) && rig.store.get(recordId).doneCount === 1); i++) {
      await sleep(10);
    }
    assert.ok(recordId, 'job started');
    assert.strictEqual(rig.store.get(recordId).doneCount, 1, 'segment 0 saved before cancel');
    assert.strictEqual(rig.transcriber.cancel(recordId), true);
    const record = await promise;
    assert.strictEqual(record.cancelled, true);
    assert.strictEqual(record.status, 'partial', 'cancelled job keeps finished parts, labeled partial');
    assert.ok(rig.store.get(recordId).text.includes('Words from segment 0.'));
    console.log('  ✓ engine: cancel kills the child, finished segments survive');
  } finally {
    fs.rmSync(rig.dir, { recursive: true, force: true });
  }
}

async function testEngineNoAudioAndModelGates() {
  // No audio track -> honest TranscribeError + failed record.
  let rig = makeRig({ durationSec: 120, hasAudio: false });
  try {
    placeModel(rig);
    await assert.rejects(
      () => rig.transcriber.transcribe({ inputPath: rig.mediaFile, title: 'Silent', modelId: 'base' }),
      (err) => err instanceof TranscribeError && err.info.class === 'no-audio-stream'
    );
    assert.strictEqual(rig.store.list()[0].status, 'failed');
  } finally {
    fs.rmSync(rig.dir, { recursive: true, force: true });
  }

  // Model absent -> model-missing with the download fix, before any spawn.
  rig = makeRig({ durationSec: 120 });
  try {
    await assert.rejects(
      () => rig.transcriber.transcribe({ inputPath: rig.mediaFile, title: 'No model', modelId: 'base' }),
      (err) => err instanceof TranscribeError && err.info.class === 'model-missing' && err.info.fix === 'redownload-model'
    );
    assert.strictEqual(rig.engine.calls.length, 0, 'no engine process runs without a verified model');
  } finally {
    fs.rmSync(rig.dir, { recursive: true, force: true });
  }

  // Corrupt model (right size, wrong bytes) -> same gate, never trusted.
  rig = makeRig({ durationSec: 120 });
  try {
    placeModel(rig, Buffer.alloc(FIXTURE_MODEL_CONTENT.length, 7));
    await assert.rejects(
      () => rig.transcriber.transcribe({ inputPath: rig.mediaFile, title: 'Corrupt', modelId: 'base' }),
      (err) => err instanceof TranscribeError && err.info.class === 'model-missing'
    );
    const status = await rig.transcriber.modelStatus('base');
    assert.deepStrictEqual({ present: status.present, valid: status.valid, reason: status.reason },
      { present: true, valid: false, reason: 'hash-mismatch' });
    console.log('  ✓ engine: no-audio + model gates (missing/corrupt never trusted)');
  } finally {
    fs.rmSync(rig.dir, { recursive: true, force: true });
  }
}

async function testReadiness() {
  // All green: engines run, model verified.
  let rig = makeRig({});
  try {
    placeModel(rig);
    const ready = await rig.transcriber.readiness('base');
    assert.strictEqual(ready.ready, true, JSON.stringify(ready.checks, null, 2));
    assert.ok(ready.checks.every((c) => c.ok));
    assert.deepStrictEqual(ready.models.base, { present: true, valid: true });
  } finally {
    fs.rmSync(rig.dir, { recursive: true, force: true });
  }

  // whisper missing (spawn ENOENT) -> plain tool-missing + repair fix.
  rig = makeRig({ whisperHelpError: Object.assign(new Error('spawn whisper-cli.exe ENOENT'), { code: 'ENOENT' }) });
  try {
    placeModel(rig);
    const ready = await rig.transcriber.readiness('base');
    assert.strictEqual(ready.ready, false);
    const check = ready.checks.find((c) => c.id === 'whisper-runs');
    assert.strictEqual(check.ok, false);
    assert.match(check.message, /could not be found/);
    assert.strictEqual(check.fix, 'repair-binaries');
  } finally {
    fs.rmSync(rig.dir, { recursive: true, force: true });
  }

  // whisper dies on a missing DLL -> translated, not raw.
  rig = makeRig({ whisperHelpStderr: 'The code execution cannot proceed because MSVCP140.dll was not found.', whisperHelpCode: 1 });
  try {
    placeModel(rig);
    const ready = await rig.transcriber.readiness('base');
    const check = ready.checks.find((c) => c.id === 'whisper-runs');
    assert.strictEqual(check.ok, false);
    assert.match(check.message, /runtime DLL/);
    assert.strictEqual(check.fix, 'repair-binaries');
    assert.ok(check.details.includes('MSVCP140'), 'raw detail kept under the details toggle');
  } finally {
    fs.rmSync(rig.dir, { recursive: true, force: true });
  }

  // Model hash mismatch -> model check names the re-download fix.
  rig = makeRig({});
  try {
    placeModel(rig, Buffer.alloc(FIXTURE_MODEL_CONTENT.length, 3));
    const ready = await rig.transcriber.readiness('base');
    const check = ready.checks.find((c) => c.id === 'model');
    assert.strictEqual(check.ok, false);
    assert.match(check.message, /damaged or incomplete/);
    assert.strictEqual(check.fix, 'redownload-model');
    assert.deepStrictEqual(ready.models.base, { present: true, valid: false });
    console.log('  ✓ readiness: green / missing tool / missing DLL / corrupt model');
  } finally {
    fs.rmSync(rig.dir, { recursive: true, force: true });
  }
}

// ---------- model download verification ----------

function webStreamOf(chunks, failAtEnd) {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      if (failAtEnd) controller.error(new Error('connection reset'));
      else controller.close();
    }
  });
}

async function testDownloadModel() {
  const rig = makeRig({});
  try {
    const progress = [];
    const okFetch = async () => ({
      ok: true, status: 200,
      body: webStreamOf([new Uint8Array(FIXTURE_MODEL_CONTENT)])
    });
    const transcriber = createTranscriber({
      userDataPath: rig.userData, resourcesBinDir: rig.resources, store: rig.store,
      spawnImpl: rig.engine.spawnImpl, fetchImpl: okFetch,
      getModel: (id) => (id === 'base' ? FIXTURE_MODEL : null), modelIds: ['base']
    });
    const res = await transcriber.downloadModel('base', (p) => progress.push(p));
    assert.strictEqual(res.ok, true);
    const dest = path.join(rig.userData, 'models', 'ggml-base.bin');
    assert.ok(fs.existsSync(dest), 'verified model lands at its final path');
    assert.ok(!fs.existsSync(`${dest}.part`), 'no .part left behind');
    assert.ok(progress.length >= 1 && progress[progress.length - 1].percent === 100);
    assert.strictEqual((await transcriber.modelStatus('base')).valid, true);

    // Hash mismatch: right length, wrong bytes -> deleted, not trusted.
    fs.rmSync(dest);
    const wrongFetch = async () => ({
      ok: true, status: 200,
      body: webStreamOf([new Uint8Array(Buffer.alloc(FIXTURE_MODEL_CONTENT.length, 9))])
    });
    const transcriber2 = createTranscriber({
      userDataPath: rig.userData, resourcesBinDir: rig.resources, store: rig.store,
      spawnImpl: rig.engine.spawnImpl, fetchImpl: wrongFetch,
      getModel: (id) => (id === 'base' ? FIXTURE_MODEL : null), modelIds: ['base']
    });
    await assert.rejects(
      () => transcriber2.downloadModel('base'),
      (err) => err instanceof TranscribeError && err.info.class === 'model-load' && err.info.fix === 'redownload-model'
    );
    assert.ok(!fs.existsSync(dest) && !fs.existsSync(`${dest}.part`), 'a failed-verification download is never kept');

    // Interrupted stream -> partial file removed, plain error.
    const flakyFetch = async () => ({
      ok: true, status: 200,
      body: webStreamOf([new Uint8Array([1, 2, 3])], true)
    });
    const transcriber3 = createTranscriber({
      userDataPath: rig.userData, resourcesBinDir: rig.resources, store: rig.store,
      spawnImpl: rig.engine.spawnImpl, fetchImpl: flakyFetch,
      getModel: (id) => (id === 'base' ? FIXTURE_MODEL : null), modelIds: ['base']
    });
    await assert.rejects(() => transcriber3.downloadModel('base'), /interrupted/);
    assert.ok(!fs.existsSync(`${dest}.part`), 'an interrupted download leaves no partial');
    console.log('  ✓ model download: verified landing, hash mismatch deleted, partial never kept');
  } finally {
    fs.rmSync(rig.dir, { recursive: true, force: true });
  }
}

// ---------- packaged payload: the DLL guarantee ----------

function testPayloadManifest() {
  const binDir = path.join(REPO_ROOT, 'resources', 'bin');
  const manifest = JSON.parse(fs.readFileSync(path.join(binDir, 'manifest.json'), 'utf8'));
  const runtimeDlls = ['vcruntime140.dll', 'vcruntime140_1.dll', 'vcruntime140_threads.dll', 'msvcp140.dll', 'vcomp140.dll'];
  for (const dll of runtimeDlls) {
    const pinned = manifest.msvcRuntime.files[dll];
    assert.ok(pinned, `${dll} is pinned in the manifest`);
    const file = path.join(binDir, dll);
    assert.ok(fs.existsSync(file), `${dll} is tracked next to the executables`);
    const actual = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    assert.strictEqual(actual, pinned, `${dll} hash matches the manifest`);
  }
  // The transcriber's runtime set and the manifest agree.
  for (const name of RUNTIME_FILES) {
    const groups = [manifest.ffmpeg.files, manifest.whisperCpp.files, manifest.msvcRuntime.files];
    assert.ok(groups.some((g) => g[name]), `${name} covered by the manifest`);
  }
  console.log('  ✓ payload manifest: private VC++ DLLs present + hash-pinned');
}

(async () => {
  testModelRegistry();
  testPlanSegments();
  testArgvBuilders();
  testParsers();
  testCoverageAndStitch();
  testClassify();
  await testEngineFullRun();
  await testEnginePartialAndRetry();
  await testEngineCancelKeepsParts();
  await testEngineNoAudioAndModelGates();
  await testReadiness();
  await testDownloadModel();
  testPayloadManifest();
  console.log('transcribe.test.js: ALL PASS');
})().catch((err) => { console.error(err); process.exit(1); });
