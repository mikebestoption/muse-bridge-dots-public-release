'use strict';

// Teach-from-video — pure core (Muse Bridge v0.4.0).
//
// Shared, environment-agnostic helpers (UMD: window.MuseSopCore in the
// renderer, module.exports under node): Vimeo URL parsing, oEmbed /
// text-track response shaping, WebVTT -> plain transcript, the frame
// sampling plan, the SOP prompt + reply parser, and SOP -> Loop draft
// conversion. No DOM, no filesystem, no network in here — fetch and
// storage live in src/sops.js / main.js, frame capture in the renderer.
//
// HONESTY RULES baked into this module:
// - A Vimeo link alone yields metadata (title/thumbnail via oEmbed).
//   The recording itself is analyzed ONLY from sampled frames and/or a
//   real transcript; when neither exists the SOP is never faked — the
//   intake record says what is missing (see buildSopUserText labels).
// - An SOP generated without a transcript is labeled
//   "from video frames only (no narration transcript)" everywhere it
//   surfaces: the stored record, the exported markdown, the Loop draft.

(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.MuseSopCore = api;
  }
})(typeof window !== 'undefined' ? window : null, function () {
  const loopsCore = typeof module !== 'undefined' && module.exports
    ? require('./loopsCore')
    : (typeof window !== 'undefined' ? window.MuseLoopsCore : null);

  const FRAME_INTERVAL_SEC = 5;
  const MAX_FRAMES = 24;
  const FRAMES_ONLY_LABEL = 'from video frames only (no narration transcript)';

  // ---------- Vimeo URLs ----------

  // Accepts vimeo.com/<id>, vimeo.com/video/<id>, player.vimeo.com/
  // video/<id> (incl. ?h=<hash> for unlisted), channel/group/album
  // shapes, and vimeo.com/<id>/<hash>. Returns { id, hash } or null.
  function parseVimeoUrl(rawUrl) {
    if (typeof rawUrl !== 'string') return null;
    const url = rawUrl.trim();
    if (!/^(https?:\/\/)?(www\.|player\.)?vimeo\.com\//i.test(url)) return null;
    const hashMatch = url.match(/[?&#]h=([0-9a-z]+)/i);
    const pathMatch = url.match(
      /vimeo\.com\/(?:video\/|channels\/[^/]+\/|groups\/[^/]+\/videos\/|album\/\d+\/video\/)?(\d{5,})(?:\/([0-9a-z]+))?/i
    );
    if (!pathMatch) return null;
    return { id: pathMatch[1], hash: (hashMatch && hashMatch[1]) || pathMatch[2] || null };
  }

  function isVideoFileName(name) {
    return /\.(mp4|webm|mov|m4v)$/i.test(String(name || ''));
  }

  // ---------- oEmbed / API response shaping ----------

  // Public oEmbed payload -> the fields the app keeps. Null-safe.
  function parseOEmbed(json) {
    if (!json || typeof json !== 'object') return null;
    return {
      title: typeof json.title === 'string' ? json.title : '',
      thumbnailUrl: typeof json.thumbnail_url === 'string' ? json.thumbnail_url : '',
      durationSec: Number.isFinite(json.duration) ? json.duration : null,
      authorName: typeof json.author_name === 'string' ? json.author_name : ''
    };
  }

  // Vimeo API texttracks response -> the one track to use:
  // an active track first, then English, then the first with a link.
  function pickTextTrack(json) {
    const tracks = json && Array.isArray(json.data) ? json.data : [];
    const usable = tracks.filter((t) => t && typeof t.link === 'string' && t.link);
    if (!usable.length) return null;
    return (
      usable.find((t) => t.active) ||
      usable.find((t) => /^en/i.test(t.language || '')) ||
      usable[0]
    );
  }

  // Vimeo API video payload -> a downloadable progressive file link.
  // Prefers the largest rendition at or under maxBytes; falls back to
  // the smallest available. Returns null when the API exposes no
  // downloads (not the owner's video, plan limits, downloads disabled).
  function pickDownloadLink(json, maxBytes) {
    const downloads = json && Array.isArray(json.download) ? json.download : [];
    const usable = downloads
      .filter((d) => d && typeof d.link === 'string' && d.link && Number.isFinite(d.size))
      .sort((a, b) => a.size - b.size);
    if (!usable.length) return null;
    const cap = Number.isFinite(maxBytes) && maxBytes > 0 ? maxBytes : Infinity;
    const under = usable.filter((d) => d.size <= cap);
    const pick = under.length ? under[under.length - 1] : usable[0];
    return { link: pick.link, size: pick.size, width: pick.width || null, height: pick.height || null };
  }

  // ---------- WebVTT -> plain transcript ----------

  function vttToText(vtt) {
    if (typeof vtt !== 'string') return '';
    const out = [];
    for (const rawLine of vtt.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) continue;
      if (/^WEBVTT/i.test(line)) continue;
      if (/^NOTE\b/i.test(line)) continue;
      if (line.includes('-->')) continue;
      if (/^\d+$/.test(line)) continue; // cue identifier
      const text = line.replace(/<[^>]+>/g, '').trim();
      if (!text) continue;
      if (out[out.length - 1] !== text) out.push(text); // VTT repeats lines across cues
    }
    return out.join('\n');
  }

  // ---------- Frame sampling plan ----------

  // Which timestamps (seconds) to sample: t=0, every intervalSec, and
  // the last moment — deduplicated, capped at maxFrames by an even
  // resample that keeps the first and last instants.
  function planFrameTimes(durationSec, opts) {
    const options = opts || {};
    const interval = Number.isFinite(options.intervalSec) && options.intervalSec > 0
      ? options.intervalSec : FRAME_INTERVAL_SEC;
    const maxFrames = Number.isFinite(options.maxFrames) && options.maxFrames > 0
      ? Math.floor(options.maxFrames) : MAX_FRAMES;
    const d = Number(durationSec);
    if (!Number.isFinite(d) || d <= 0) return [];
    const round = (t) => Math.round(t * 100) / 100;
    const times = [0];
    for (let t = interval; t < d - 0.25; t += interval) times.push(round(t));
    const last = round(Math.max(0, d - 0.1));
    if (times.length === 1) {
      if (d > 0.2) times.push(last);
    } else if (last - times[times.length - 1] > 0.5) {
      times.push(last);
    }
    const unique = [...new Set(times)].sort((a, b) => a - b);
    if (unique.length <= maxFrames) return unique;
    const sampled = [];
    for (let i = 0; i < maxFrames; i++) {
      sampled.push(unique[Math.round((i * (unique.length - 1)) / (maxFrames - 1))]);
    }
    return [...new Set(sampled)];
  }

  // ---------- SOP prompt + reply parsing ----------

  const SOP_SYSTEM_PROMPT = [
    'You are Muse Spark, running inside the Muse Bridge desktop app.',
    'Michael shows you recordings of himself doing tasks on his computer',
    'so you can turn them into precise Standard Operating Procedures (SOPs)',
    'that a person — or the app, step by approved step — can follow later.',
    'You are given sampled frames from the recording in order, and the',
    'narration transcript when one exists. Describe only what the frames',
    'and transcript actually show; never invent screens, buttons, or',
    'values that are not visible or spoken. When a step is unclear, say',
    'so in the Watch-outs instead of guessing.'
  ].join('\n');

  const SOP_FORMAT_SPEC = [
    'Write the SOP in EXACTLY this markdown format:',
    '',
    '# <short title of the task>',
    '',
    '## Goal',
    '<one or two sentences: what this accomplishes and when to use it>',
    '',
    '## What you need first',
    '- <app/site/file/login that must be ready>',
    '',
    '## Steps',
    '1. <the exact action — what to click, type, or open>',
    '   - Where/what exactly: <the precise control, menu, field, or value>',
    '   - Expected result: <what should be visible when this step worked>',
    '2. <next action>',
    '   - Where/what exactly: <...>',
    '   - Expected result: <...>',
    '',
    '## Watch-outs',
    '- <mistakes to avoid, anything unclear in the recording>'
  ].join('\n');

  function buildSopUserText({ title, transcript, frameCount, transcriptSource }) {
    const hasTranscript = typeof transcript === 'string' && transcript.trim().length > 0;
    const lines = [
      `Turn this recording into an SOP. Recording title: ${title || 'Untitled recording'}.`,
      ''
    ];
    if (frameCount > 0) {
      lines.push(`You are shown ${frameCount} frame(s) sampled from the recording, in order.`);
    } else {
      lines.push('No frames could be sampled from this recording — base the SOP on the transcript only, and note that in the Watch-outs.');
    }
    if (hasTranscript) {
      lines.push(`Narration transcript (source: ${transcriptSource || 'provided'}):`);
      lines.push('---');
      lines.push(transcript.slice(0, 60000));
      lines.push('---');
    } else {
      lines.push(`There is NO narration transcript for this recording — it is ${FRAMES_ONLY_LABEL}. Base every step strictly on the frames.`);
    }
    lines.push('');
    lines.push(SOP_FORMAT_SPEC);
    return lines.join('\n');
  }

  function stripMd(text) {
    return String(text || '').replace(/\*\*/g, '').replace(/__/g, '').trim();
  }

  function bulletLines(block) {
    const items = [];
    for (const rawLine of String(block || '').split(/\r?\n/)) {
      const line = rawLine.trim();
      const m = line.match(/^(?:[-*•]|\d+[.)])\s+(.*)$/);
      if (m) items.push(stripMd(m[1]));
      else if (line && items.length) items[items.length - 1] += ` ${stripMd(line)}`;
    }
    return items.filter(Boolean);
  }

  function parseSteps(block) {
    const steps = [];
    let current = null;
    for (const rawLine of String(block || '').split(/\r?\n/)) {
      const line = rawLine.trim();
      const start = line.match(/^\d+[.)]\s+(.*)$/);
      if (start) {
        if (current) steps.push(current);
        current = { action: stripMd(start[1]), detail: '', expected: '' };
        continue;
      }
      if (!current || !line) continue;
      const detail = line.match(/^[-*•]?\s*(?:where\/what exactly|where|what exactly|detail|details)\s*[:\-]\s*(.*)$/i);
      const expected = line.match(/^[-*•]?\s*(?:expected result|expected|result)\s*[:\-]\s*(.*)$/i);
      if (detail) current.detail = stripMd(detail[1]);
      else if (expected) current.expected = stripMd(expected[1]);
      else {
        const extra = stripMd(line.replace(/^[-*•]\s*/, ''));
        if (extra) current.detail = current.detail ? `${current.detail} ${extra}` : extra;
      }
    }
    if (current) steps.push(current);
    return steps.filter((s) => s.action);
  }

  // Forgiving parser for the SOP format above. Anything unparseable
  // still yields the raw text (kept on the record), never a throw.
  function parseSopReply(text) {
    const raw = typeof text === 'string' ? text : '';
    const result = { title: '', goal: '', needs: [], steps: [], watchOuts: [], raw };
    const titleMatch = raw.match(/^#\s+(.+)$/m);
    if (titleMatch) result.title = stripMd(titleMatch[1]);

    const sections = {};
    const parts = raw.split(/^##\s+/m);
    for (const part of parts.slice(1)) {
      const nl = part.indexOf('\n');
      if (nl === -1) continue;
      const heading = part.slice(0, nl).trim().toLowerCase();
      sections[heading] = part.slice(nl + 1).trim();
    }
    const find = (...names) => {
      for (const key of Object.keys(sections)) {
        if (names.some((n) => key.includes(n))) return sections[key];
      }
      return '';
    };
    result.goal = stripMd(find('goal').split(/\n/)[0] || '');
    result.needs = bulletLines(find('need', 'before you start', 'prerequisite', 'requirements'));
    result.steps = parseSteps(find('steps', 'procedure'));
    result.watchOuts = bulletLines(find('watch', 'caution', 'notes'));
    if (!result.steps.length && !find('steps', 'procedure')) {
      // No Steps heading at all: try numbered lines anywhere in the text.
      result.steps = parseSteps(raw);
    }
    return result;
  }

  // The saved/exported markdown for one SOP record.
  function sopToMarkdown({ title, sop, sourceLabel, transcriptSource, frameCount, createdAt }) {
    const s = sop || {};
    const lines = [
      `# SOP: ${s.title || title || 'Untitled SOP'}`,
      '',
      `Source: ${sourceLabel || 'recording'} · Frames sampled: ${frameCount || 0} · Transcript: ${transcriptSource && transcriptSource !== 'none' ? transcriptSource : FRAMES_ONLY_LABEL}${createdAt ? ` · Created: ${createdAt}` : ''}`,
      ''
    ];
    if (s.goal) lines.push('## Goal', '', s.goal, '');
    if (s.needs && s.needs.length) {
      lines.push('## What you need first', '');
      for (const n of s.needs) lines.push(`- ${n}`);
      lines.push('');
    }
    lines.push('## Steps', '');
    (s.steps || []).forEach((step, i) => {
      lines.push(`${i + 1}. ${step.action}`);
      if (step.detail) lines.push(`   - Where/what exactly: ${step.detail}`);
      if (step.expected) lines.push(`   - Expected result: ${step.expected}`);
    });
    lines.push('');
    if (s.watchOuts && s.watchOuts.length) {
      lines.push('## Watch-outs', '');
      for (const w of s.watchOuts) lines.push(`- ${w}`);
      lines.push('');
    }
    return lines.join('\n');
  }

  // ---------- SOP -> Loop draft ----------

  // Steps whose text unambiguously names a mechanical action are
  // pre-typed as task steps and flagged needsReview; everything else
  // becomes an instruction step with the SOP's text preserved verbatim.
  // The result is a DRAFT — it is never auto-run.
  function detectTaskAction(step) {
    const text = `${step.action || ''} ${step.detail || ''}`;
    const urlMatch = text.match(/https?:\/\/[^\s)"'<>]+/i);
    if (urlMatch && /\b(open|go to|navigate|visit|launch|browse)\b/i.test(step.action || '')) {
      return { type: 'open_url', url: urlMatch[0].replace(/[.,;]+$/, '') };
    }
    const fileMatch = (step.action || '').match(
      /create a (?:new )?file (?:named|called) ["“']?([^"”'\n]+?\.[a-z0-9]{1,8})["”']?/i
    );
    if (fileMatch) {
      return { type: 'create_file', path: `~/${fileMatch[1].trim()}`, content: '' };
    }
    return null;
  }

  function sopToLoopDraft(sopRecord) {
    const sop = (sopRecord && sopRecord.sop) || {};
    const title = sop.title || sopRecord.title || 'Video SOP';
    const steps = [];
    let seq = 0;
    const nextId = () => (loopsCore ? loopsCore.newStepId() : `step-sop-${++seq}`);
    if (sop.needs && sop.needs.length) {
      steps.push({ id: nextId(), type: 'note', text: `Before you start: ${sop.needs.join('; ')}` });
    }
    for (const step of sop.steps || []) {
      const action = detectTaskAction(step);
      if (action) {
        steps.push({ id: nextId(), type: 'task', action, needsReview: true });
      } else {
        const parts = [step.action];
        if (step.detail) parts.push(step.detail);
        if (step.expected) parts.push(`(Expected: ${step.expected})`);
        steps.push({ id: nextId(), type: 'instruction', text: parts.filter(Boolean).join(' — ') });
      }
    }
    if (sop.watchOuts && sop.watchOuts.length) {
      steps.push({ id: nextId(), type: 'note', text: `Watch out: ${sop.watchOuts.join('; ')}` });
    }
    if (!steps.length) {
      steps.push({ id: nextId(), type: 'instruction', text: 'Follow the SOP document for this recording.' });
    }
    return {
      name: `${title} (from SOP)`.slice(0, 120),
      description:
        `Draft loop converted from the video SOP "${title}" — review every step before running; nothing here has been run.` +
        (sop.goal ? ` Goal: ${sop.goal}` : ''),
      steps
    };
  }

  return {
    FRAME_INTERVAL_SEC,
    MAX_FRAMES,
    FRAMES_ONLY_LABEL,
    SOP_SYSTEM_PROMPT,
    SOP_FORMAT_SPEC,
    parseVimeoUrl,
    isVideoFileName,
    parseOEmbed,
    pickTextTrack,
    pickDownloadLink,
    vttToText,
    planFrameTimes,
    buildSopUserText,
    parseSopReply,
    sopToMarkdown,
    detectTaskAction,
    sopToLoopDraft
  };
});
