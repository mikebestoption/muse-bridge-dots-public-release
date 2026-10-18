'use strict';

// Teach-from-video tests (v0.4.0) — Vimeo URL parsing, oEmbed/text-track
// fixtures (injected fetch, zero network), frame-sampling plan math,
// WebVTT stripping, SOP reply parsing, SOP -> Loop conversion mapping,
// and the SOP store. Tmp dirs only.
// Run: node tests/sops.test.js

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const core = require('../src/sopCore');
const { createSopsStore, fetchVimeoOEmbed, fetchVimeoTranscript, mockSop } = require('../src/sops');
const { createVideoStore, MAX_VIDEO_BYTES } = require('../src/videoFiles');
const loopsCore = require('../src/loopsCore');

function testVimeoUrls() {
  assert.deepStrictEqual(core.parseVimeoUrl('https://vimeo.com/123456789'), { id: '123456789', hash: null });
  assert.deepStrictEqual(core.parseVimeoUrl('https://vimeo.com/video/123456789'), { id: '123456789', hash: null });
  assert.deepStrictEqual(
    core.parseVimeoUrl('https://player.vimeo.com/video/123456789?h=abcdef0123'),
    { id: '123456789', hash: 'abcdef0123' },
    'unlisted player URL keeps its privacy hash'
  );
  assert.deepStrictEqual(
    core.parseVimeoUrl('https://vimeo.com/123456789/abcdef0123'),
    { id: '123456789', hash: 'abcdef0123' }
  );
  assert.deepStrictEqual(
    core.parseVimeoUrl('https://vimeo.com/channels/staffpicks/123456789'),
    { id: '123456789', hash: null }
  );
  assert.strictEqual(core.parseVimeoUrl('https://www.youtube.com/watch?v=123456789'), null, 'not Vimeo -> null');
  assert.strictEqual(core.parseVimeoUrl('https://vimeo.com/about'), null, 'no video id -> null');
  assert.strictEqual(core.parseVimeoUrl('not a url'), null);
  assert.strictEqual(core.parseVimeoUrl(''), null);
  console.log('  ✓ vimeo URL parsing');
}

function testOEmbedAndTracks() {
  const oembed = core.parseOEmbed({
    title: 'How to file a fill', thumbnail_url: 'https://i.vimeocdn.com/t.jpg',
    duration: 185, author_name: 'Michael'
  });
  assert.deepStrictEqual(oembed, {
    title: 'How to file a fill', thumbnailUrl: 'https://i.vimeocdn.com/t.jpg',
    durationSec: 185, authorName: 'Michael'
  });
  assert.strictEqual(core.parseOEmbed(null), null);
  assert.deepStrictEqual(core.parseOEmbed({}), { title: '', thumbnailUrl: '', durationSec: null, authorName: '' });

  const tracksJson = {
    data: [
      { id: '1', language: 'es', link: 'https://example.test/es.vtt', active: false },
      { id: '2', language: 'en', link: 'https://example.test/en.vtt', active: false },
      { id: '3', language: 'fr', link: 'https://example.test/fr.vtt', active: true }
    ]
  };
  assert.strictEqual(core.pickTextTrack(tracksJson).language, 'fr', 'active track wins');
  const noActive = { data: tracksJson.data.map((t) => ({ ...t, active: false })) };
  assert.strictEqual(core.pickTextTrack(noActive).language, 'en', 'then English');
  assert.strictEqual(core.pickTextTrack({ data: [] }), null);
  assert.strictEqual(core.pickTextTrack({}), null);

  const videoJson = {
    download: [
      { link: 'https://example.test/360.mp4', size: 10 * 1024 * 1024, width: 640 },
      { link: 'https://example.test/1080.mp4', size: 90 * 1024 * 1024, width: 1920 },
      { link: 'https://example.test/720.mp4', size: 40 * 1024 * 1024, width: 1280 }
    ]
  };
  assert.strictEqual(core.pickDownloadLink(videoJson, 50 * 1024 * 1024).width, 1280, 'largest under the cap');
  assert.strictEqual(core.pickDownloadLink(videoJson, 5 * 1024 * 1024).width, 640, 'over cap everywhere -> smallest');
  assert.strictEqual(core.pickDownloadLink({}, 1000), null, 'no downloads exposed -> null');
  console.log('  ✓ oembed shaping, text-track pick, download pick');
}

const VTT_FIXTURE = [
  'WEBVTT - Captions',
  '',
  '1',
  '00:00:00.000 --> 00:00:04.000',
  'First click the <b>green</b> Fills button.',
  '',
  '2',
  '00:00:04.000 --> 00:00:08.000',
  'First click the green Fills button.',
  '',
  '3',
  '00:00:08.000 --> 00:00:12.000',
  'Then choose the client from the list.',
  ''
].join('\n');

function testVtt() {
  const text = core.vttToText(VTT_FIXTURE);
  assert.strictEqual(
    text,
    'First click the green Fills button.\nThen choose the client from the list.',
    'headers/timestamps/tags stripped, repeated cue lines deduplicated'
  );
  assert.strictEqual(core.vttToText(''), '');
  assert.strictEqual(core.vttToText(null), '');
  console.log('  ✓ WebVTT -> transcript');
}

function testFramePlan() {
  assert.deepStrictEqual(core.planFrameTimes(0), [], 'no duration -> no frames');
  assert.deepStrictEqual(core.planFrameTimes(-5), []);
  assert.deepStrictEqual(core.planFrameTimes(NaN), []);
  assert.deepStrictEqual(core.planFrameTimes(3), [0, 2.9], 'short clip: first + last');
  assert.deepStrictEqual(core.planFrameTimes(10), [0, 5, 9.9], 'interval + last');
  assert.deepStrictEqual(core.planFrameTimes(25), [0, 5, 10, 15, 20, 24.9]);
  const hour = core.planFrameTimes(3600);
  assert.strictEqual(hour.length, 24, 'long video caps at 24 frames');
  assert.strictEqual(hour[0], 0, 'cap keeps the first frame');
  assert.strictEqual(hour[hour.length - 1], 3599.9, 'cap keeps the last frame');
  for (let i = 1; i < hour.length; i++) assert.ok(hour[i] > hour[i - 1], 'times strictly increase');
  const custom = core.planFrameTimes(30, { intervalSec: 2, maxFrames: 4 });
  assert.strictEqual(custom.length, 4, 'custom cap honored');
  console.log('  ✓ frame sampling plan math');
}

const SOP_REPLY = [
  '# File a fill in Elevate',
  '',
  '## Goal',
  'Record a client fill payment in Elevate so the ledger stays current.',
  '',
  '## What you need first',
  '- Elevate open and signed in',
  '- The client payment details',
  '',
  '## Steps',
  '1. Open https://app.example.test/fills in your browser',
  '   - Where/what exactly: The Fills page, top navigation',
  '   - Expected result: The fills list is visible',
  '2. Click the green New Fill button',
  '   - Where/what exactly: Top-right of the fills list',
  '   - Expected result: The New Fill form opens',
  '3. Create a file called fills-draft.txt with the amounts',
  '   - Expected result: The draft exists for checking',
  '',
  '## Watch-outs',
  '- Do not submit before checking the totals'
].join('\n');

function testSopParsingAndConversion() {
  const sop = core.parseSopReply(SOP_REPLY);
  assert.strictEqual(sop.title, 'File a fill in Elevate');
  assert.ok(sop.goal.startsWith('Record a client fill payment'));
  assert.deepStrictEqual(sop.needs, ['Elevate open and signed in', 'The client payment details']);
  assert.strictEqual(sop.steps.length, 3);
  assert.strictEqual(sop.steps[1].detail, 'Top-right of the fills list');
  assert.strictEqual(sop.steps[1].expected, 'The New Fill form opens');
  assert.deepStrictEqual(sop.watchOuts, ['Do not submit before checking the totals']);

  const empty = core.parseSopReply('total garbage with no structure');
  assert.deepStrictEqual(empty.steps, [], 'unstructured reply parses to no steps, never throws');
  assert.ok(empty.raw.includes('total garbage'), 'raw reply preserved');

  // SOP -> Loop draft: URL step + create-file step become task steps
  // flagged for review; the click step stays an instruction with its
  // text (incl. expected result) preserved.
  const draft = core.sopToLoopDraft({ title: 'Recording', sop });
  assert.strictEqual(draft.name, 'File a fill in Elevate (from SOP)');
  const types = draft.steps.map((s) => s.type);
  assert.deepStrictEqual(types, ['note', 'task', 'instruction', 'task', 'note'], 'needs note, task, instruction, task, watch-out note');
  const urlTask = draft.steps[1];
  assert.deepStrictEqual(urlTask.action, { type: 'open_url', url: 'https://app.example.test/fills' });
  assert.strictEqual(urlTask.needsReview, true, 'auto-typed steps are flagged for review');
  const instr = draft.steps[2];
  assert.ok(instr.text.includes('Click the green New Fill button'), 'instruction preserves the SOP action text');
  assert.ok(instr.text.includes('(Expected: The New Fill form opens)'), 'instruction preserves the expected result');
  const fileTask = draft.steps[3];
  assert.strictEqual(fileTask.action.type, 'create_file');
  assert.strictEqual(fileTask.action.path, '~/fills-draft.txt');

  // The draft is a valid loop payload for the store's own validator.
  const validated = loopsCore.validateLoopData(draft);
  assert.strictEqual(validated.steps.length, 5, 'draft passes loop validation');
  assert.strictEqual(validated.steps[1].needsReview, true, 'needsReview survives validation');

  // Exported markdown states the frames-only label honestly.
  const md = core.sopToMarkdown({
    title: 'Recording', sop, sourceLabel: 'vimeo.com/123456789',
    transcriptSource: 'none', frameCount: 7, createdAt: '2026-10-18T00:00:00.000Z'
  });
  assert.ok(md.includes(core.FRAMES_ONLY_LABEL), 'no-transcript SOP is labeled frames-only');
  assert.ok(md.includes('Frames sampled: 7'));
  console.log('  ✓ SOP reply parsing + SOP->Loop conversion mapping');
}

function testPromptBuilding() {
  const withT = core.buildSopUserText({ title: 'Demo', transcript: 'spoken words', frameCount: 5, transcriptSource: 'vimeo-captions' });
  assert.ok(withT.includes('spoken words'));
  assert.ok(withT.includes('5 frame(s)'));
  assert.ok(withT.includes('## Steps'), 'format spec included');
  const without = core.buildSopUserText({ title: 'Demo', transcript: '', frameCount: 5, transcriptSource: 'none' });
  assert.ok(without.includes(core.FRAMES_ONLY_LABEL), 'frames-only case is labeled in the prompt itself');
  console.log('  ✓ SOP prompt building (transcript + frames-only labels)');
}

async function testFetchHelpers() {
  // oEmbed through an injected fetch fixture.
  const seen = [];
  const fakeFetch = async (url) => {
    seen.push(url);
    return {
      ok: true,
      json: async () => ({ title: 'Demo', thumbnail_url: 'https://i.vimeocdn.com/x.jpg', duration: 42, author_name: 'M' }),
      text: async () => ''
    };
  };
  const meta = await fetchVimeoOEmbed('https://vimeo.com/123456789', fakeFetch);
  assert.strictEqual(meta.title, 'Demo');
  assert.ok(seen[0].startsWith('https://vimeo.com/api/oembed.json?url='), 'oEmbed endpoint used');

  const failing = async () => ({ ok: false, status: 404, json: async () => ({}), text: async () => '' });
  await assert.rejects(() => fetchVimeoOEmbed('https://vimeo.com/1', failing), /could not read that link/);

  // Transcript: texttracks fixture -> picked track -> VTT fixture -> text.
  const apiFetch = async (url) => {
    if (url.includes('/texttracks')) {
      return {
        ok: true,
        json: async () => ({ data: [{ language: 'en', link: 'https://example.test/en.vtt', active: true }] }),
        text: async () => ''
      };
    }
    return { ok: true, json: async () => ({}), text: async () => VTT_FIXTURE };
  };
  const transcript = await fetchVimeoTranscript('123456789', 'fixture-token-not-real', apiFetch);
  assert.ok(transcript.text.includes('green Fills button'), 'transcript fetched + stripped');
  assert.strictEqual(transcript.language, 'en');
  console.log('  ✓ vimeo fetch helpers on fixtures (oEmbed + transcript)');
}

async function testStoreAndVideo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-sops-'));
  try {
    const store = createSopsStore(dir);
    assert.deepStrictEqual(store.list(), []);
    const rec = store.createIntake({
      sourceKind: 'vimeo', title: 'Demo recording',
      sourceLabel: 'vimeo.com/123456789', sourceUrl: 'https://vimeo.com/123456789'
    });
    assert.strictEqual(rec.status, 'intake', 'a link alone is intake — nothing analyzed yet');
    assert.strictEqual(rec.hasTranscript, false);
    assert.throws(() => store.createIntake({ sourceKind: 'carrier-pigeon' }), /Vimeo link or a video file/);

    const withTranscript = store.update(rec.id, {
      transcriptText: 'spoken words here', transcriptSource: 'user-file', frameCount: 6
    });
    assert.strictEqual(withTranscript.hasTranscript, true);
    assert.ok(!('transcriptText' in withTranscript), 'list/update views never carry the transcript body');
    assert.strictEqual(store.get(rec.id).transcriptText, 'spoken words here', 'owner get() returns the transcript');

    const sop = mockSop({ title: 'Demo recording', transcriptText: 'Open the app. Click Fills. Save the form.', frameCount: 6 });
    assert.strictEqual(sop.steps.length, 3, 'mock SOP turns transcript sentences into steps');
    assert.ok(sop.goal.includes('Mock mode'), 'mock SOP is labeled as mock');
    const generated = store.update(rec.id, { sop });
    assert.strictEqual(generated.status, 'generated');
    assert.ok(generated.markdown.includes('# SOP: Demo recording'), 'markdown rendered on generation');
    assert.ok(generated.markdown.includes('Transcript: user-file'));

    assert.strictEqual(store.remove(rec.id), true);
    assert.strictEqual(store.get(rec.id), null);

    // Video staging: streamed copy, cap enforced, path lookup guarded.
    const videos = createVideoStore(dir);
    const srcFile = path.join(dir, 'clip.mp4');
    fs.writeFileSync(srcFile, Buffer.alloc(1024, 7));
    const staged = await videos.stageCopy(srcFile);
    assert.ok(staged.id.startsWith('vid-'));
    assert.strictEqual(staged.size, 1024);
    const stagedPath = videos.getPath(staged.id);
    assert.ok(stagedPath && fs.existsSync(stagedPath), 'staged copy exists');
    assert.strictEqual(fs.readFileSync(stagedPath).length, 1024, 'copy is byte-complete');
    assert.strictEqual(videos.getPath('vid-nope'), null);
    await assert.rejects(() => videos.stageCopy(path.join(dir, 'notes.txt')), /Not a video file/);
    const bigFile = path.join(dir, 'big.mp4');
    fs.writeFileSync(bigFile, Buffer.alloc(0));
    // Sparse-grow past the cap without writing 500 MB of real bytes.
    fs.truncateSync(bigFile, MAX_VIDEO_BYTES + 1);
    await assert.rejects(() => videos.stageCopy(bigFile), /limit is 500 MB/);
    console.log('  ✓ SOP store + streamed video staging (500 MB cap)');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

(async () => {
  testVimeoUrls();
  testOEmbedAndTracks();
  testVtt();
  testFramePlan();
  testSopParsingAndConversion();
  testPromptBuilding();
  await testFetchHelpers();
  await testStoreAndVideo();
  console.log('sops.test.js: ALL PASS');
})().catch((err) => { console.error(err); process.exit(1); });
