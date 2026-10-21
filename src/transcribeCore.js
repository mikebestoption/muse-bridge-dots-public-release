'use strict';

// Local transcription — pure core (Muse Bridge v0.4.5).
//
// Everything in here is deterministic and side-effect free so it is
// unit-tested under bare node: the model registry (pinned download
// URLs + SHA-256), the segment planner for long recordings, the
// ffmpeg / whisper.cpp argument builders, the output parsers, the
// coverage math ("Transcribed 62:10 of 62:10" — never silently
// partial), the transcript stitcher, and the translator that turns
// child-process failures into plain-language guidance with a fix.
//
// The engine that actually spawns processes lives in
// src/transcriber.js; the library store in src/transcripts.js.
//
// HONESTY RULES baked in:
// - A transcript that did not cover the whole recording is labeled
//   PARTIAL and names the exact missing ranges.
// - Speaker labels are never invented: whisper.cpp has no
//   diarization, so a transcript is one clean text with a timestamp
//   per segment.
// - Transcription needs NO internet and NO AI tokens: the only
//   download ever is the speech model itself, once, hash-verified.

const SEGMENT_SEC = 300; // 5-minute chunks: a long meeting marches visibly to the end
const LONG_MEDIA_SEC = 900; // beyond ~15 minutes, recommend the meeting model
const MEETING_MODEL_ID = 'large-v3-turbo';
const DEFAULT_MODEL_ID = 'base';

// Pinned speech models (multilingual — Michael works in English AND
// Spanish, so never the .en-only variants). Sizes + SHA-256 are the
// HuggingFace LFS values for ggerganov/whisper.cpp, verified at build
// time (see resources/bin/NOTICE.md for the runtime binaries).
const MODELS = {
  base: {
    id: 'base',
    file: 'ggml-base.bin',
    label: 'Fast',
    blurb: 'Best for short clips, voice notes and quick checks. Smallest download.',
    size: 147951465,
    sizeLabel: '~150 MB',
    sha256: '60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe',
    url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin'
  },
  small: {
    id: 'small',
    file: 'ggml-small.bin',
    label: 'Balanced',
    blurb: 'Sharper than Fast on clear speech, still quick. Middle download.',
    size: 487601967,
    sizeLabel: '~490 MB',
    sha256: '1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b',
    url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin'
  },
  'large-v3-turbo': {
    id: 'large-v3-turbo',
    file: 'ggml-large-v3-turbo.bin',
    label: 'Meeting quality',
    blurb: 'Recommended for meetings and long recordings — the most accurate ear, fewest dropped or garbled words.',
    size: 1624555275,
    sizeLabel: '~1.6 GB',
    sha256: '1fc70f774d38eb169993ac391eea357ef47c88757ef72ee5943879b7e8e2bc69',
    url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin'
  }
};

const LANGUAGES = ['auto', 'en', 'es'];

function getModel(id) {
  return MODELS[id] || null;
}

function modelForSettings(id) {
  return MODELS[id] ? id : DEFAULT_MODEL_ID;
}

// ---------- time formatting ----------

// Seconds -> "62:10": minutes are unbounded (a 62-minute meeting
// reads "62:10", the way the coverage header is quoted to the user),
// seconds zero-padded. Used for coverage headers, segment timestamps
// and missing-range labels.
function formatMediaTime(sec) {
  const total = Math.max(0, Math.round(Number.isFinite(sec) ? sec : 0));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

// ---------- segment planning ----------

// Split a recording into transcription segments. Unknown duration
// (probe failed) yields ONE open-ended segment (end: null) — the
// pipeline then transcribes the whole file as a single chunk and the
// coverage is computed from what actually came back.
function planSegments(durationSec, segmentSec) {
  const size = Number.isFinite(segmentSec) && segmentSec > 0 ? segmentSec : SEGMENT_SEC;
  const d = Number(durationSec);
  if (!Number.isFinite(d) || d <= 0) {
    return [{ index: 0, start: 0, end: null }];
  }
  const segments = [];
  let index = 0;
  for (let start = 0; start < d - 0.05; start += size) {
    segments.push({ index: index++, start, end: Math.min(d, start + size) });
  }
  if (!segments.length) segments.push({ index: 0, start: 0, end: d });
  return segments;
}

// ---------- argv builders ----------

// Probe: `ffmpeg -i <file>` exits 1 on purpose; its stderr carries the
// Duration line and the stream list.
function buildFfmpegProbeArgs(inputPath) {
  return ['-hide_banner', '-i', String(inputPath)];
}

// Extract one segment's audio as 16 kHz mono WAV (the shape
// whisper.cpp reads). -ss sits AFTER -i: sample-accurate segment
// boundaries, still fast for audio-only decode.
function buildExtractArgs(inputPath, segment, outWav) {
  const args = ['-y', '-hide_banner', '-i', String(inputPath)];
  if (segment && Number.isFinite(segment.start) && segment.start > 0) {
    args.push('-ss', String(Math.round(segment.start * 1000) / 1000));
  }
  if (segment && Number.isFinite(segment.end) && Number.isFinite(segment.start)) {
    args.push('-t', String(Math.round((segment.end - segment.start) * 1000) / 1000));
  }
  args.push('-vn', '-ac', '1', '-ar', '16000', String(outWav));
  return args;
}

// whisper-cli invocation: text output (no timestamps — the app adds
// one timestamp per segment itself) + full JSON for segment timings
// and the detected language.
function buildWhisperArgs({ modelPath, wavPath, outBase, language }) {
  const lang = LANGUAGES.includes(language) ? language : 'auto';
  return [
    '-m', String(modelPath),
    '-f', String(wavPath),
    '-l', lang,
    '-otxt',
    '-ojf',
    '-of', String(outBase),
    '-nt',
    '-pp'
  ];
}

// ---------- output parsers ----------

// Parse the stderr of `ffmpeg -i`: { durationSec|null, hasAudio }.
function parseFfmpegProbe(stderr) {
  const text = String(stderr || '');
  const durMatch = text.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  let durationSec = null;
  if (durMatch) {
    durationSec =
      parseInt(durMatch[1], 10) * 3600 +
      parseInt(durMatch[2], 10) * 60 +
      parseFloat(durMatch[3]);
  }
  const hasAudio = /Stream\s+#\d+:\d+[^:\n]*:\s*Audio:/.test(text) || /Stream\s+#\d+:\d+\s*\([^)]*\):\s*Audio:/.test(text);
  return { durationSec, hasAudio };
}

// Parse the stderr progress lines whisper-cli prints with -pp:
// "whisper_print_progress_callback: progress =  37%".
const WHISPER_PROGRESS_RE = /progress\s*=\s*(\d+)%/;
function parseWhisperProgress(line) {
  const m = WHISPER_PROGRESS_RE.exec(String(line || ''));
  if (!m) return null;
  const pct = parseInt(m[1], 10);
  return Number.isFinite(pct) ? Math.min(100, Math.max(0, pct)) : null;
}

// Parse whisper.cpp's JSON output (both -oj and -ojf shapes):
// { text, segments: [{ start, end, text }], language }
function parseWhisperJson(jsonText) {
  let parsed = null;
  try {
    parsed = JSON.parse(String(jsonText || ''));
  } catch (_) {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const language =
    (parsed.result && typeof parsed.result.language === 'string' && parsed.result.language) ||
    (parsed.params && typeof parsed.params.language === 'string' && parsed.params.language) ||
    '';
  const items = Array.isArray(parsed.transcription) ? parsed.transcription : [];
  const segments = [];
  const texts = [];
  for (const item of items) {
    if (!item || typeof item.text !== 'string') continue;
    const text = item.text.trim();
    const offsets = item.offsets || {};
    const startMs = Number.isFinite(offsets.from) ? offsets.from : null;
    const endMs = Number.isFinite(offsets.to) ? offsets.to : null;
    segments.push({
      start: startMs != null ? startMs / 1000 : null,
      end: endMs != null ? endMs / 1000 : null,
      text
    });
    if (text) texts.push(text);
  }
  return { text: texts.join(' ').replace(/\s+/g, ' ').trim(), segments, language };
}

function countWords(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return 0;
  return trimmed.split(/\s+/).length;
}

// ---------- coverage + stitching ----------

// segments: the plan ([{index,start,end}]). results: Map or object of
// index -> 'done' | 'failed' | anything else (pending/missing counts
// as not covered). Returns the coverage facts the UI and the library
// record share: covered seconds, the exact missing ranges, and
// whether the transcript is complete.
function computeCoverage(segments, results) {
  const plan = Array.isArray(segments) ? segments : [];
  const statusOf = (index) => {
    if (!results) return undefined;
    if (typeof results.get === 'function') return results.get(index);
    return results[index];
  };
  let totalSec = 0;
  let coveredSec = 0;
  const missing = [];
  for (const seg of plan) {
    const len = Number.isFinite(seg.end) && Number.isFinite(seg.start) ? Math.max(0, seg.end - seg.start) : 0;
    totalSec += len;
    if (statusOf(seg.index) === 'done') {
      coveredSec += len;
    } else if (Number.isFinite(seg.end)) {
      missing.push({ start: seg.start, end: seg.end });
    }
  }
  // Merge adjacent missing ranges (segment N and N+1 both failed read
  // as one gap, e.g. "missing 20:00–30:00").
  const merged = [];
  for (const range of missing) {
    const last = merged[merged.length - 1];
    if (last && Math.abs(last.end - range.start) < 0.6) last.end = range.end;
    else merged.push({ ...range });
  }
  return {
    totalSec,
    coveredSec,
    missingRanges: merged,
    complete: plan.length > 0 && merged.length === 0
  };
}

function coverageHeader({ coveredSec, totalSec, complete, missingRanges }) {
  const head = `Transcribed ${formatMediaTime(coveredSec)} of ${formatMediaTime(totalSec)}`;
  if (complete) return head;
  const ranges = (missingRanges || [])
    .map((r) => `missing ${formatMediaTime(r.start)}–${formatMediaTime(r.end)}`)
    .join('; ');
  return `${head} — PARTIAL (${ranges || 'some parts did not finish'})`;
}

// The finished transcript document: a coverage header, then one block
// per completed segment, each headed by its media timestamp. Failed
// segments appear as an explicit gap line — never a silent hole.
function stitchTranscript({ title, segments, coverage }) {
  const lines = [];
  lines.push(`Transcript: ${title || 'Untitled recording'}`);
  lines.push(coverageHeader(coverage));
  lines.push('');
  const ordered = [...(segments || [])].sort((a, b) => a.start - b.start);
  for (const seg of ordered) {
    const stamp = formatMediaTime(seg.start);
    if (seg.status === 'done') {
      lines.push(`[${stamp}]`);
      lines.push((seg.text || '').trim());
      lines.push('');
    } else if (seg.status === 'failed' || seg.status === 'pending') {
      if (Number.isFinite(seg.end)) {
        lines.push(`[${stamp}] — (not transcribed: ${formatMediaTime(seg.start)}–${formatMediaTime(seg.end)})`);
        lines.push('');
      }
    }
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

// ---------- failure translation ----------

// Child-process failure classes the app knows how to explain (and
// mostly self-repair). `fix` names the repair action the UI offers:
//   'redownload-model' | 'repair-binaries' | 'install-vcredist' |
//   'pick-another-file' | null (just explain)
const ERROR_CLASSES = {
  MISSING_DLL: 'missing-dll',
  BAD_ARCHITECTURE: 'bad-architecture',
  MODEL_LOAD: 'model-load',
  MODEL_MISSING: 'model-missing',
  UNSUPPORTED_MEDIA: 'unsupported-media',
  NO_AUDIO_STREAM: 'no-audio-stream',
  TOOL_MISSING: 'tool-missing',
  CANCELLED: 'cancelled',
  UNKNOWN: 'unknown'
};

// Classify one child-process failure into plain language.
// input: { tool: 'ffmpeg'|'whisper'|'download', code, signal, stderr,
//          spawnError (Error from a failed spawn, e.g. ENOENT),
//          exitCodeText (Windows NTSTATUS as hex when known) }
function classifyToolError(input) {
  const { tool, code, stderr, spawnError } = input || {};
  const errText = `${(stderr || '').toString()}\n${spawnError ? spawnError.message || '' : ''}`;
  const lower = errText.toLowerCase();

  if (spawnError && (spawnError.code === 'ENOENT' || /ENOENT/.test(spawnError.message || ''))) {
    return {
      class: ERROR_CLASSES.TOOL_MISSING,
      message:
        tool === 'whisper'
          ? 'The transcription engine (whisper) could not be found on this PC.'
          : 'A tool the app needs (ffmpeg) could not be found on this PC.',
      fix: 'repair-binaries'
    };
  }
  if (/0xc0000135|cannot find the dll|dll.*not found|the code execution cannot proceed/.test(lower)) {
    return {
      class: ERROR_CLASSES.MISSING_DLL,
      message:
        'A support file (a Microsoft runtime DLL) that the transcription engine needs is missing or damaged, so Windows refused to start it.',
      fix: 'repair-binaries'
    };
  }
  if (/0xc000007b|not a valid win32|wrong architecture|%1 is not a valid/.test(lower)) {
    return {
      class: ERROR_CLASSES.BAD_ARCHITECTURE,
      message:
        'Windows could not start the transcription engine — its support files do not match this PC (the classic 0xc000007b error). Replacing the bundled runtime files usually fixes it.',
      fix: 'repair-binaries'
    };
  }
  if (tool === 'whisper' && /failed to load model|whisper_init_with_params|invalid model|model.*corrupt|read error.*model/.test(lower)) {
    return {
      class: ERROR_CLASSES.MODEL_LOAD,
      message:
        'The speech model file could not be loaded — it is damaged or incomplete. Downloading a fresh, verified copy fixes it.',
      fix: 'redownload-model'
    };
  }
  if (tool === 'ffmpeg' && /matches no streams|output file is empty|does not contain any stream|no stream found/.test(lower)) {
    return {
      class: ERROR_CLASSES.NO_AUDIO_STREAM,
      message: 'That video has no audio track, so there is nothing to transcribe.',
      fix: null
    };
  }
  if (tool === 'ffmpeg' && /moov atom not found|invalid data found|unsupported codec|unknown decoder|format not supported/.test(lower)) {
    return {
      class: ERROR_CLASSES.UNSUPPORTED_MEDIA,
      message: 'That file could not be read — it may be damaged, or in a format the app cannot open. Nothing was transcribed.',
      fix: 'pick-another-file'
    };
  }
  return {
    class: ERROR_CLASSES.UNKNOWN,
    message:
      tool === 'whisper'
        ? `Transcription stopped unexpectedly (exit code ${code == null ? 'unknown' : code}).`
        : `Reading that file stopped unexpectedly (exit code ${code == null ? 'unknown' : code}).`,
    fix: null
  };
}

// The model-absent case is detected before any process runs, but it
// shares the same shape so the UI renders one vocabulary.
function modelMissingError(model) {
  return {
    class: ERROR_CLASSES.MODEL_MISSING,
    message: `The ${model ? model.label : ''} speech model is not downloaded yet. It downloads once (about ${model ? model.sizeLabel : '150 MB'}) and is verified before use — after that, transcription works fully offline.`,
    fix: 'redownload-model'
  };
}

module.exports = {
  SEGMENT_SEC,
  LONG_MEDIA_SEC,
  MEETING_MODEL_ID,
  DEFAULT_MODEL_ID,
  MODELS,
  LANGUAGES,
  getModel,
  modelForSettings,
  formatMediaTime,
  planSegments,
  buildFfmpegProbeArgs,
  buildExtractArgs,
  buildWhisperArgs,
  parseFfmpegProbe,
  parseWhisperProgress,
  parseWhisperJson,
  countWords,
  computeCoverage,
  coverageHeader,
  stitchTranscript,
  ERROR_CLASSES,
  classifyToolError,
  modelMissingError
};
