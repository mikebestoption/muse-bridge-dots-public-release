'use strict';

// Local transcription engine — main process (Muse Bridge v0.4.5).
//
// Pipeline per recording:
//   probe (ffmpeg -i) -> plan 5-minute segments -> per segment:
//   ffmpeg extracts that slice as 16 kHz mono WAV -> whisper-cli
//   transcribes it -> the segment text is saved into the Transcripts
//   library record IMMEDIATELY -> temp WAV deleted. When all segments
//   finish, the record is finalized with its coverage ("Transcribed
//   62:10 of 62:10", or PARTIAL with the missing ranges named).
//
// Self-sufficiency (the "only errors" fix): the runtime binaries live
// in resources/bin (pristine, shipped) and are seeded into a writable
// working copy at userData/bin on first use. The Microsoft runtime
// DLLs sit next to the executables so Windows loads them privately —
// no system install, no admin, no missing-DLL failures. Readiness
// runs REAL probes (ffmpeg -version, whisper-cli --help, model hash)
// and every failure is translated into plain language with a Fix
// (src/transcribeCore.js classifyToolError) — raw stderr is kept on
// `details` for the UI's details toggle, never as the headline.
//
// Transcription needs NOTHING from the internet and NO AI service:
// the only download is the speech model, once, SHA-256 verified.
// No Python is involved anywhere in this pipeline.
//
// All process/network/fs access is injectable for tests.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { pipeline } = require('stream/promises');
const { Readable } = require('stream');
const core = require('./transcribeCore');

// The runtime set, mirroring resources/bin/manifest.json. The DLLs
// are the private-runtime guarantee; if they are absent the whisper
// executables cannot start on a clean machine.
const RUNTIME_FILES = [
  'ffmpeg.exe',
  'whisper-cli.exe',
  'whisper.dll',
  'ggml.dll',
  'ggml-base.dll',
  'ggml-cpu.dll',
  'vcruntime140.dll',
  'vcruntime140_1.dll',
  'vcruntime140_threads.dll',
  'msvcp140.dll',
  'vcomp140.dll'
];
const RUNTIME_DLLS = RUNTIME_FILES.filter((f) => f.endsWith('.dll') && !f.startsWith('ggml') && f !== 'whisper.dll');

class TranscribeError extends Error {
  constructor(info, details) {
    super(info && info.message ? info.message : 'Transcription failed.');
    this.name = 'TranscribeError';
    this.info = info || { class: core.ERROR_CLASSES.UNKNOWN, message: this.message, fix: null };
    this.details = details || '';
  }
}

function createTranscriber(deps) {
  const userDataPath = deps.userDataPath;
  if (typeof userDataPath !== 'string' || !userDataPath) {
    throw new Error('createTranscriber requires a userData path.');
  }
  const resourcesBinDir = deps.resourcesBinDir || '';
  const store = deps.store || null;
  const spawnImpl = deps.spawnImpl || spawn;
  const fetchImpl = deps.fetchImpl || null;
  // Model lookup is injectable so the pipeline can be tested
  // end-to-end with a tiny fixture model whose hash is real.
  const getModel = typeof deps.getModel === 'function' ? deps.getModel : core.getModel;
  const modelIds = Array.isArray(deps.modelIds) ? deps.modelIds : Object.keys(core.MODELS);
  const fsp = (deps.fsImpl || fs).promises || fs.promises;
  const fsSync = deps.fsImpl || fs;

  const binDir = path.join(userDataPath, 'bin');
  const modelsDir = path.join(userDataPath, 'models');
  const tmpRoot = path.join(userDataPath, 'transcribe-tmp');

  const activeJobs = new Map(); // recordId -> { children: Set, cancelled }
  const hashCache = new Map(); // file -> { size, mtimeMs, sha256 }

  // ---------- binary seeding / verification ----------

  function fileSize(file) {
    try {
      const st = fsSync.statSync(file);
      return st.isFile() ? st.size : 0;
    } catch (_) {
      return 0;
    }
  }

  async function sha256File(file) {
    const st = await fsp.stat(file);
    const cached = hashCache.get(file);
    if (cached && cached.size === st.size && cached.mtimeMs === st.mtimeMs) return cached.sha256;
    const hash = crypto.createHash('sha256');
    await pipeline(fsSync.createReadStream(file), hash);
    const digest = hash.digest('hex');
    hashCache.set(file, { size: st.size, mtimeMs: st.mtimeMs, sha256: digest });
    return digest;
  }

  // Working copies live in userData/bin (writable: an antivirus
  // quarantine or a damaged install can be repaired by re-seeding
  // from the pristine resources copy).
  async function ensureBinaries() {
    await fsp.mkdir(binDir, { recursive: true });
    const copied = [];
    const missing = [];
    for (const name of RUNTIME_FILES) {
      const dest = path.join(binDir, name);
      if (fileSize(dest) > 0) continue;
      const src = resourcesBinDir ? path.join(resourcesBinDir, name) : '';
      if (src && fileSize(src) > 0) {
        try {
          await fsp.copyFile(src, dest);
          copied.push(name);
          continue;
        } catch (_) { /* fall through to missing */ }
      }
      missing.push(name);
    }
    return { ok: missing.length === 0, copied, missing, binDir };
  }

  function binariesPresent() {
    const missing = RUNTIME_FILES.filter((name) => fileSize(path.join(binDir, name)) === 0);
    return { ok: missing.length === 0, missing };
  }

  // ---------- child processes ----------

  // Runs a child to completion, streaming stderr lines to onLine.
  // Resolves { code, stdout, stderr } for ANY exit code; rejects only
  // when the process could not be started at all (spawn error), with
  // err.spawnError set for the classifier.
  function runChild(job, cmd, args, onLine) {
    return new Promise((resolve, reject) => {
      let child;
      try {
        child = spawnImpl(cmd, args, { windowsHide: true });
      } catch (err) {
        err.spawnError = err;
        reject(err);
        return;
      }
      if (job) job.children.add(child);
      let stdout = '';
      let stderr = '';
      let stderrTail = '';
      let buf = '';
      const emitLines = (chunk) => {
        buf += chunk;
        let idx;
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx);
          buf = buf.slice(idx + 1);
          if (onLine) onLine(line);
        }
      };
      if (child.stdout) child.stdout.on('data', (d) => { stdout += d.toString(); });
      if (child.stderr) {
        child.stderr.on('data', (d) => {
          const text = d.toString();
          stderr += text;
          stderrTail = (stderrTail + text).slice(-8192);
          emitLines(text);
        });
      }
      child.on('error', (err) => {
        if (job) job.children.delete(child);
        err.spawnError = err;
        reject(err);
      });
      child.on('close', (code) => {
        if (job) job.children.delete(child);
        if (buf && onLine) onLine(buf);
        resolve({ code, stdout, stderr: stderrTail || stderr });
      });
    });
  }

  function tail(text, n) {
    const s = String(text || '');
    return s.length > n ? s.slice(-n) : s;
  }

  // ---------- models ----------

  function modelFile(modelId) {
    const model = getModel(modelId);
    return model ? path.join(modelsDir, model.file) : null;
  }

  // Size check is cheap; the hash is verified on download and cached
  // by (size, mtime) afterwards.
  async function modelStatus(modelId) {
    const model = getModel(modelId);
    if (!model) return { id: modelId, present: false, valid: false, reason: 'unknown-model' };
    const file = modelFile(modelId);
    const size = fileSize(file);
    if (size === 0) return { id: modelId, present: false, valid: false, reason: 'missing' };
    if (size !== model.size) return { id: modelId, present: true, valid: false, reason: 'size-mismatch', size };
    const sha = await sha256File(file);
    return { id: modelId, present: true, valid: sha === model.sha256, reason: sha === model.sha256 ? 'ok' : 'hash-mismatch' };
  }

  async function downloadModel(modelId, onProgress) {
    const model = getModel(modelId);
    if (!model) throw new Error(`Unknown speech model: ${modelId}`);
    const doFetch = fetchImpl || (typeof fetch === 'function' ? fetch : null);
    if (!doFetch) throw new Error('No network fetch is available in this environment.');
    await fsp.mkdir(modelsDir, { recursive: true });
    const dest = modelFile(modelId);
    const part = `${dest}.part`;
    const res = await doFetch(model.url);
    if (!res || !res.ok || !res.body) {
      throw new Error(`The model download failed (HTTP ${res ? res.status : 'no response'}). Check your connection and try again.`);
    }
    let received = 0;
    const counter = new (require('stream').Transform)({
      transform(chunk, _enc, cb) {
        received += chunk.length;
        if (onProgress) onProgress({ received, total: model.size, percent: Math.min(100, Math.round((received / model.size) * 100)) });
        cb(null, chunk);
      }
    });
    try {
      await pipeline(Readable.fromWeb(res.body), counter, fsSync.createWriteStream(part));
    } catch (err) {
      try { await fsp.unlink(part); } catch (_) { /* partial never survives a failed stream */ }
      throw new Error(`The model download was interrupted (${err.message}). Nothing partial was kept — try again.`);
    }
    const size = fileSize(part);
    if (size !== model.size) {
      try { await fsp.unlink(part); } catch (_) { /* ignore */ }
      throw new Error(`The downloaded model is the wrong size (${size} bytes, expected ${model.size}). It was not kept — try the download again.`);
    }
    hashCache.delete(dest);
    const sha = await sha256File(part);
    if (sha !== model.sha256) {
      try { await fsp.unlink(part); } catch (_) { /* ignore */ }
      throw new TranscribeError(
        { class: core.ERROR_CLASSES.MODEL_LOAD, message: 'The downloaded model did not pass its verification check, so it was deleted rather than trusted. Try the download again.', fix: 'redownload-model' },
        `sha256 ${sha} != expected ${model.sha256}`
      );
    }
    await fsp.rename(part, dest);
    hashCache.delete(dest);
    return { ok: true, model: modelId, path: dest, size };
  }

  // ---------- readiness ----------

  // Real executions where possible; each check is { id, label, ok,
  // message, fix }. `fix` vocabulary matches transcribeCore.
  async function readiness(selectedModelId) {
    const checks = [];
    const seeded = await ensureBinaries();
    const present = binariesPresent();
    checks.push({
      id: 'binaries',
      label: 'Engine files (whisper + ffmpeg + runtime DLLs)',
      ok: present.ok,
      message: present.ok
        ? `All ${RUNTIME_FILES.length} engine files are in place (including the Microsoft runtime DLLs, loaded privately).`
        : `Missing: ${present.missing.join(', ')}.`,
      fix: present.ok ? null : 'repair-binaries'
    });

    if (present.ok) {
      try {
        const res = await runChild(null, path.join(binDir, 'ffmpeg.exe'), ['-hide_banner', '-version'], null);
        const runs = res.code === 0 && /ffmpeg version/i.test(res.stdout + res.stderr);
        checks.push({
          id: 'ffmpeg-runs',
          label: 'ffmpeg starts',
          ok: runs,
          message: runs ? 'ffmpeg runs.' : 'ffmpeg did not start cleanly.',
          fix: runs ? null : 'repair-binaries',
          details: runs ? '' : tail(res.stderr, 800)
        });
        if (!runs) {
          const info = core.classifyToolError({ tool: 'ffmpeg', code: res.code, stderr: res.stderr });
          checks[checks.length - 1].message = info.message;
          checks[checks.length - 1].fix = info.fix || 'repair-binaries';
        }
      } catch (err) {
        const info = core.classifyToolError({ tool: 'ffmpeg', spawnError: err.spawnError || err });
        checks.push({ id: 'ffmpeg-runs', label: 'ffmpeg starts', ok: false, message: info.message, fix: info.fix || 'repair-binaries', details: tail(err.message, 800) });
      }
      try {
        const res = await runChild(null, path.join(binDir, 'whisper-cli.exe'), ['--help'], null);
        const runs = /usage:/i.test(res.stdout + res.stderr);
        checks.push({
          id: 'whisper-runs',
          label: 'whisper engine starts',
          ok: runs,
          message: runs ? 'The whisper engine runs.' : 'The whisper engine did not start cleanly.',
          fix: runs ? null : 'repair-binaries',
          details: runs ? '' : tail(res.stderr, 800)
        });
        if (!runs) {
          const info = core.classifyToolError({ tool: 'whisper', code: res.code, stderr: res.stderr });
          checks[checks.length - 1].message = info.message;
          checks[checks.length - 1].fix = info.fix || 'repair-binaries';
        }
      } catch (err) {
        const info = core.classifyToolError({ tool: 'whisper', spawnError: err.spawnError || err });
        checks.push({ id: 'whisper-runs', label: 'whisper engine starts', ok: false, message: info.message, fix: info.fix || 'repair-binaries', details: tail(err.message, 800) });
      }
    }

    const modelId = core.modelForSettings(selectedModelId);
    const status = await modelStatus(modelId);
    const model = getModel(modelId);
    checks.push({
      id: 'model',
      label: `Speech model (${model.label})`,
      ok: status.valid,
      message: status.valid
        ? `Downloaded and verified (${model.sizeLabel}).`
        : status.reason === 'missing'
          ? `Not downloaded yet — one download of about ${model.sizeLabel}, verified before use.`
          : 'The model file is damaged or incomplete — a fresh verified download fixes it.',
      fix: status.valid ? null : 'redownload-model'
    });

    let tmpOk = true;
    try {
      await fsp.mkdir(tmpRoot, { recursive: true });
      const probeFile = path.join(tmpRoot, `.probe-${Date.now()}`);
      await fsp.writeFile(probeFile, 'ok');
      await fsp.unlink(probeFile);
    } catch (_) {
      tmpOk = false;
    }
    checks.push({
      id: 'temp-writable',
      label: 'Working space writable',
      ok: tmpOk,
      message: tmpOk ? 'The app can write its temporary audio files.' : 'The app cannot write to its own data folder — check the folder permissions.',
      fix: null
    });

    let diskOk = true;
    let diskMessage = 'Disk space is fine.';
    try {
      const stats = await fsp.statfs(userDataPath);
      const free = stats.bavail * stats.bsize;
      const need = status.valid ? 512 * 1024 * 1024 : model.size + 512 * 1024 * 1024;
      diskOk = free > need;
      diskMessage = diskOk
        ? `${Math.round(free / (1024 * 1024 * 1024))} GB free.`
        : `Only ${Math.round(free / (1024 * 1024))} MB free — not enough room for the model and working files.`;
    } catch (_) { /* statfs unavailable: do not block on it */ }
    checks.push({ id: 'disk', label: 'Free disk space', ok: diskOk, message: diskMessage, fix: null });

    const models = {};
    for (const id of modelIds) {
      const st = await modelStatus(id);
      models[id] = { present: st.present, valid: st.valid };
    }
    return { ready: checks.every((c) => c.ok), checks, models, binDir, seededCopied: seeded.copied };
  }

  // Repair: drop the working copies and re-seed from resources, then
  // re-verify by actually starting both engines.
  async function repairBinaries() {
    for (const name of RUNTIME_FILES) {
      try { await fsp.unlink(path.join(binDir, name)); } catch (_) { /* absent is fine */ }
    }
    const seeded = await ensureBinaries();
    return seeded;
  }

  // ---------- transcription ----------

  function jobTmpDir(recordId) {
    return path.join(tmpRoot, recordId);
  }

  async function cleanupJobTmp(recordId) {
    try {
      await fsp.rm(jobTmpDir(recordId), { recursive: true, force: true });
    } catch (_) { /* temp cleanup is best-effort; files are transient by design */ }
  }

  // Transcribe one media file. Creates (or resumes) the library
  // record and saves every finished segment into it as it lands.
  // opts: { inputPath, title, sourceName, sourceKind, modelId,
  //         language, recordId?, onlySegments?, onProgress? }
  // Resolves the finalized library record (status complete/partial).
  // Throws TranscribeError for systemic failures (no model, engine
  // broken, no audio) — per-segment failures are recorded, not thrown.
  async function transcribe(opts) {
    const {
      inputPath, title, sourceName, sourceKind,
      modelId, language, onProgress
    } = opts || {};
    if (!inputPath) throw new Error('transcribe requires an input path.');
    if (!store) throw new Error('transcribe requires the transcripts store.');
    const model = getModel(core.modelForSettings(modelId));
    const lang = core.LANGUAGES.includes(language) ? language : 'auto';

    const seeded = await ensureBinaries();
    if (!seeded.ok) {
      const info = {
        class: core.ERROR_CLASSES.TOOL_MISSING,
        message: `The transcription engine files are incomplete (missing: ${seeded.missing.join(', ')}), and the app could not restore them from its bundled copy.`,
        fix: 'repair-binaries'
      };
      throw new TranscribeError(info);
    }
    const status = await modelStatus(model.id);
    if (!status.valid) {
      throw new TranscribeError(core.modelMissingError(model), `model status: ${status.reason}`);
    }

    const ffmpeg = path.join(binDir, 'ffmpeg.exe');
    const whisper = path.join(binDir, 'whisper-cli.exe');
    const job = { children: new Set(), cancelled: false };

    // Probe first: duration drives the segment plan.
    let probe;
    try {
      const res = await runChild(job, ffmpeg, core.buildFfmpegProbeArgs(inputPath), null);
      probe = core.parseFfmpegProbe(res.stderr);
    } catch (err) {
      const info = core.classifyToolError({ tool: 'ffmpeg', spawnError: err.spawnError || err });
      throw new TranscribeError(info, tail(err.message, 800));
    }

    // A resume/retry targets an existing record and its plan.
    let record = null;
    if (opts.recordId) {
      record = store.get(opts.recordId);
      if (!record) throw new Error('That transcript record no longer exists.');
    }
    const plan = record && Array.isArray(record.plan) && record.plan.length
      ? record.plan
      : core.planSegments(probe.durationSec);
    if (!record) {
      record = store.createJob({
        title: title || path.basename(String(inputPath)).replace(/\.[^.]+$/, ''),
        sourceName: sourceName || path.basename(String(inputPath)),
        sourceKind: sourceKind || 'file',
        sourceRef: opts.sourceRef || '',
        model: model.id,
        language: lang,
        durationSec: probe.durationSec || 0,
        plan
      });
    } else {
      store.setStatus(record.id, 'transcribing');
      record = store.get(record.id);
    }
    activeJobs.set(record.id, job);
    const recordId = record.id;
    const tmpDir = jobTmpDir(recordId);
    await fsp.mkdir(tmpDir, { recursive: true });

    const emit = (patch) => {
      if (typeof onProgress === 'function') onProgress({ recordId, ...patch });
    };

    try {
      if (!probe.hasAudio) {
        const info = { class: core.ERROR_CLASSES.NO_AUDIO_STREAM, message: 'That file has no audio track, so there is nothing to transcribe.', fix: null };
        store.finalize(recordId, info);
        throw new TranscribeError(info);
      }

      const doneBefore = new Set(
        (record.segments || []).filter((s) => s.status === 'done').map((s) => s.index)
      );
      const only = Array.isArray(opts.onlySegments) ? new Set(opts.onlySegments) : null;
      const work = plan.filter((seg) => {
        if (only) return only.has(seg.index);
        return !doneBefore.has(seg.index);
      });
      const totalSegments = plan.length;
      let covered = (record.segments || [])
        .filter((s) => s.status === 'done')
        .reduce((sum, s) => sum + (Number.isFinite(s.end) ? s.end - s.start : 0), 0);

      for (let w = 0; w < work.length; w++) {
        const seg = work[w];
        if (job.cancelled) break;
        emit({
          phase: 'segment',
          segmentIndex: seg.index,
          segmentNumber: plan.indexOf(seg) + 1,
          segmentCount: totalSegments,
          coveredSec: covered,
          totalSec: probe.durationSec || record.durationSec || 0,
          percent: 0
        });
        const wavPath = path.join(tmpDir, `seg-${seg.index}.wav`);
        const outBase = path.join(tmpDir, `seg-${seg.index}`);
        try {
          const extract = await runChild(job, ffmpeg, core.buildExtractArgs(inputPath, seg, wavPath), null);
          if (job.cancelled) break;
          if (extract.code !== 0 || fileSize(wavPath) === 0) {
            const info = core.classifyToolError({ tool: 'ffmpeg', code: extract.code, stderr: extract.stderr });
            if (info.class === core.ERROR_CLASSES.NO_AUDIO_STREAM) {
              // One silent slice is a failed segment, not a dead job.
              store.updateSegment(recordId, seg.index, { status: 'failed' });
              continue;
            }
            throw new TranscribeError(info, tail(extract.stderr, 1200));
          }
          const run = await runChild(
            job,
            whisper,
            core.buildWhisperArgs({ modelPath: modelFile(model.id), wavPath, outBase, language: lang }),
            (line) => {
              const pct = core.parseWhisperProgress(line);
              if (pct != null) {
                emit({
                  phase: 'segment',
                  segmentIndex: seg.index,
                  segmentNumber: plan.indexOf(seg) + 1,
                  segmentCount: totalSegments,
                  coveredSec: covered,
                  totalSec: probe.durationSec || record.durationSec || 0,
                  percent: pct
                });
              }
            }
          );
          if (job.cancelled) break;
          if (run.code !== 0) {
            const info = core.classifyToolError({ tool: 'whisper', code: run.code, stderr: run.stderr });
            if (info.class === core.ERROR_CLASSES.MODEL_LOAD ||
                info.class === core.ERROR_CLASSES.MISSING_DLL ||
                info.class === core.ERROR_CLASSES.BAD_ARCHITECTURE ||
                info.class === core.ERROR_CLASSES.TOOL_MISSING) {
              throw new TranscribeError(info, tail(run.stderr, 1200));
            }
            store.updateSegment(recordId, seg.index, { status: 'failed' });
            continue;
          }
          let text = '';
          let detected = '';
          try {
            const txt = await fsp.readFile(`${outBase}.txt`, 'utf8');
            text = txt.trim();
          } catch (_) { /* JSON below is the fallback */ }
          try {
            const parsed = core.parseWhisperJson(await fsp.readFile(`${outBase}.json`, 'utf8'));
            if (parsed) {
              if (!text) text = parsed.text;
              detected = parsed.language || '';
            }
          } catch (_) { /* txt already captured */ }
          store.updateSegment(recordId, seg.index, { status: 'done', text, detectedLanguage: detected || undefined });
          covered += Number.isFinite(seg.end) ? seg.end - seg.start : 0;
          emit({
            phase: 'segment-done',
            segmentIndex: seg.index,
            segmentNumber: plan.indexOf(seg) + 1,
            segmentCount: totalSegments,
            coveredSec: covered,
            totalSec: probe.durationSec || record.durationSec || 0,
            percent: 100
          });
        } finally {
          // Temp WAVs and whisper outputs never outlive their segment.
          for (const f of [wavPath, `${outBase}.txt`, `${outBase}.json`]) {
            try { await fsp.unlink(f); } catch (_) { /* already gone */ }
          }
        }
      }

      const final = store.finalize(recordId);
      return { ...final, cancelled: job.cancelled };
    } catch (err) {
      if (err instanceof TranscribeError) {
        try { store.finalize(recordId, err.info); } catch (_) { /* record may be gone */ }
      }
      throw err;
    } finally {
      activeJobs.delete(recordId);
      await cleanupJobTmp(recordId);
    }
  }

  function cancel(recordId) {
    const job = activeJobs.get(recordId);
    if (!job) return false;
    job.cancelled = true;
    for (const child of job.children) {
      try { child.kill(); } catch (_) { /* already exited */ }
    }
    return true;
  }

  return {
    binDir,
    modelsDir,
    ensureBinaries,
    repairBinaries,
    binariesPresent,
    modelStatus,
    downloadModel,
    readiness,
    transcribe,
    cancel,
    TranscribeError
  };
}

module.exports = { createTranscriber, TranscribeError, RUNTIME_FILES, RUNTIME_DLLS };
