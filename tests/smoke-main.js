'use strict';

// Headless Electron smoke test (run under xvfb):
//   xvfb-run -a npx electron tests/smoke-main.js
// Uses a throwaway userData dir and FAKE credentials only. Verifies:
//   1. the real app boots and renders
//   2. vault create + unlock + add entry through the real IPC surface
//   3. a mock chat "fill the login for Test Bank" renders an approval card
//      that names the entry — and does NOT contain the fake password
//   4. v0.3.2 small-viewport layout: at 1280x720 and 1024x640 the Settings
//      card fits the window, its Save footer stays inside the viewport and
//      does not move while the settings body scrolls (overflow-y auto), and
//      every drawer (Audits/Vault/Terminals/Night Queue) keeps its head
//      visible with a scrolling body (Night Queue's Approve row pinned).
//   5. v0.3.4 attachments: the classifier module loads in the renderer,
//      the native file input is invisible, the drop overlay shows on
//      dragenter and cancels on Escape, and a simulated drop stages a
//      document chip (and refuses a binary with an honest note).
//   6. v0.4.0 Loops + Teach-from-video (v0.4.2: Loops opens at the
//      top, full-height, closing other drawers): core modules load in the
//      renderer; a loop with prompt/instruction/note steps is created
//      via the real store, reordered in the builder UI, saved, and run
//      in mock mode to completion (instruction step via its Done tap);
//      a fixture video file is staged via the real streamed copy, a
//      mock SOP is generated from a transcript, converted into a draft
//      loop, and exported; the frame sampler fails honestly on the
//      non-video fixture instead of faking frames.
//   7. v0.4.1 Ask Muse: with no GitHub token, composing a request in
//      the panel saves an honest local draft (status chip + the
//      add-your-token note + Copy fallback — never a fake send); the
//      Settings token field round-trips (hasGithubToken boolean only)
//      and settings.json never holds the token in plaintext.
// Prints SMOKE PASS and exits 0, or SMOKE FAIL and exits 1.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, BrowserWindow } = require('electron');

app.disableHardwareAcceleration();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-smoke-'));
app.setPath('userData', tmp);

// v0.3: the hands-guard module must load in main and decide sanely.
const sessionGuard = require('../src/sessionGuard');
if (!sessionGuard.isHandsAction('fill_login') || sessionGuard.isHandsAction('list_folder')) {
  console.log('SMOKE FAIL: sessionGuard hands-action set is wrong');
  app.exit(1);
}
const probeDecision = sessionGuard.decide({
  platform: 'win32', idleMs: 0, desktopTypable: false, mode: 'queue', waitedMs: 0, settings: {}
});
if (probeDecision.decision !== 'PARK' || probeDecision.reason !== 'session') {
  console.log('SMOKE FAIL: sessionGuard does not park a locked session');
  app.exit(1);
}
console.log('  ✓ sessionGuard loaded; locked session → PARK (session)');

// v0.3.1: the path resolver must load in main and apply the win32 rules
// (Michael's guessed-profile bug) with path.win32 semantics on any host.
const pathResolver = require('../src/pathResolver');
const winResolver = pathResolver.createResolver({
  specialFolders: {
    home: 'C:\\Users\\Real', desktop: 'C:\\Users\\Real\\Desktop',
    documents: 'C:\\Users\\Real\\Documents', downloads: 'C:\\Users\\Real\\Downloads'
  },
  pathImpl: require('path').win32
});
if (winResolver.resolve('c:\\Users\\Guessed\\Desktop\\x.txt') !== 'C:\\Users\\Real\\Desktop\\x.txt') {
  console.log('SMOKE FAIL: pathResolver does not re-root a guessed profile path');
  app.exit(1);
}
console.log('  ✓ pathResolver loaded; guessed profile → real Desktop');

require('../main.js');

const FAKE_PW = 'Fake!Pass-98765';

const PAGE_SCRIPT = `
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = { steps: [] };
  try {
    // v0.3: hands-guard settings ship with the documented defaults.
    const pubSettings = await window.desktop.getSettings();
    if (pubSettings.handsIdleThresholdSeconds !== 30) throw new Error('hands idle threshold default != 30: ' + pubSettings.handsIdleThresholdSeconds);
    if (pubSettings.handsMaxWaitMinutes !== 30) throw new Error('hands max wait default != 30: ' + pubSettings.handsMaxWaitMinutes);
    out.steps.push('hands-guard settings defaults present (30 s idle / 30 min max wait)');

    // v0.3.1: task:resolve maps proposal paths onto real OS folders before
    // a card is rendered ("~" must never survive to the approval card).
    const resolvedSmoke = await window.desktop.resolveTask({ type: 'create_file', path: '~/smoke-note.txt', content: '' });
    if (!resolvedSmoke || typeof resolvedSmoke.path !== 'string' || resolvedSmoke.path.includes('~')) {
      throw new Error('task:resolve did not expand ~: ' + JSON.stringify(resolvedSmoke));
    }
    if (!resolvedSmoke.path.endsWith('smoke-note.txt')) throw new Error('task:resolve lost the filename: ' + resolvedSmoke.path);
    out.steps.push('task:resolve IPC returns OS-resolved paths');

    // Vault: create, add an entry, verify public status shape.
    let res = await window.desktop.vaultCreate('smoke-master-password');
    if (!res.ok) throw new Error('vaultCreate: ' + res.error);
    out.steps.push('vault created + unlocked');

    res = await window.desktop.vaultAddEntry({
      label: 'Test Bank', username: 'mike-test', password: '${FAKE_PW}',
      totpSecret: 'JBSWY3DPEHPK3PXP', targetTitle: 'Test Bank — Sign in'
    });
    if (!res.ok) throw new Error('vaultAddEntry: ' + res.error);
    out.steps.push('entry added');

    const planning = await window.desktop.vaultListForPlanning();
    if (JSON.stringify(planning).includes('${FAKE_PW}')) throw new Error('PLANNING VIEW LEAKED THE PASSWORD');
    out.steps.push('planning view clean: ' + JSON.stringify(planning));

    // Open the Vault panel and confirm the entry renders label+username only.
    document.getElementById('toggle-vault').click();
    await sleep(400);
    const vaultText = document.getElementById('vault-body').innerText;
    if (!vaultText.includes('Test Bank') || !vaultText.includes('mike-test')) throw new Error('vault panel did not render the entry');
    if (vaultText.includes('${FAKE_PW}')) throw new Error('VAULT PANEL LEAKED THE PASSWORD');
    out.steps.push('vault panel renders entry, no secret');

    // Drive the composer: mock fill_login proposal -> approval card.
    document.getElementById('close-vault').click();
    const input = document.getElementById('input');
    input.value = 'fill the login for Test Bank';
    document.getElementById('send').click();
    let cardText = '';
    for (let i = 0; i < 40; i++) {
      await sleep(500);
      const card = document.querySelector('.task-card');
      if (card) { cardText = card.innerText; break; }
    }
    if (!cardText) throw new Error('no task card rendered');
    if (!cardText.includes('Test Bank')) throw new Error('card does not name the entry: ' + cardText);
    if (!cardText.includes('mike-test')) throw new Error('card does not show the username');
    if (cardText.includes('${FAKE_PW}')) throw new Error('APPROVAL CARD LEAKED THE PASSWORD');
    out.steps.push('fill_login approval card rendered clean');

    // Deny the card: nothing runs, denial is recorded.
    const deny = document.querySelector('.task-card .deny');
    deny.click();
    await sleep(300);
    out.steps.push('card denied cleanly');
    out.ok = true;
  } catch (err) {
    out.ok = false;
    out.error = err.message;
  }
  return out;
})()
`;

// v0.3.4: attachment UX assertions — the pure classifier is live in the
// page (window.MuseAttachments), the native file input is invisible,
// the drop overlay shows on dragenter and cancels on Escape, and a
// simulated drop of a text file stages a document chip that can be
// removed again. Throws (failing the smoke) on the first violation.
const ATTACH_SCRIPT = `
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const checks = [];
  const M = window.MuseAttachments;
  if (!M) throw new Error('window.MuseAttachments missing — src/attachments.js did not load in the renderer');
  checks.push('attachments module loaded in renderer');
  const docCls = M.classifyFile({ name: 'note.txt', type: 'text/plain', size: 12, sample: new TextEncoder().encode('hello world') });
  if (docCls.kind !== 'document') throw new Error('classify .txt in page failed: ' + JSON.stringify(docCls));
  const binCls = M.classifyFile({ name: 'setup.exe', type: '', size: 99, sample: new Uint8Array([77, 90, 0, 3, 0, 0]) });
  if (binCls.kind !== 'unsupported') throw new Error('classify .exe in page failed: ' + JSON.stringify(binCls));
  checks.push('in-page classification: text -> document, exe -> unsupported');

  const fileInput = document.getElementById('attach-file');
  if (!fileInput) throw new Error('attach-file input missing');
  const inputDisplay = getComputedStyle(fileInput).display;
  if (inputDisplay !== 'none') throw new Error('native file input is VISIBLE (display=' + inputDisplay + ') — the v0.3.3 raw "Choose File" bug');
  if (!fileInput.multiple) throw new Error('file picker does not accept multiple files');
  checks.push('native file input hidden; picker accepts multiple');

  const overlay = document.getElementById('drop-overlay');
  if (!overlay) throw new Error('drop overlay element missing');
  if (!overlay.classList.contains('hidden')) throw new Error('drop overlay visible at rest');
  const row = document.getElementById('attachments-row');
  if (!row) throw new Error('attachments chips row missing');
  checks.push('drop overlay + chips row present, overlay hidden at rest');

  // Simulated drag: overlay appears on dragenter with Files.
  const dt = new DataTransfer();
  dt.items.add(new File(['hello from a dropped file'], 'dropped-note.txt', { type: 'text/plain' }));
  window.dispatchEvent(new DragEvent('dragenter', { dataTransfer: dt, bubbles: true }));
  await sleep(80);
  if (overlay.classList.contains('hidden')) throw new Error('overlay did not show on dragenter');
  checks.push('dragenter shows the drop overlay');

  // Drop: overlay hides and the text file stages as a document chip.
  window.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true }));
  await sleep(400);
  if (!overlay.classList.contains('hidden')) throw new Error('overlay did not hide after drop');
  const chipText = row.innerText || '';
  if (!chipText.includes('dropped-note.txt')) throw new Error('no chip for the dropped text file: ' + chipText);
  if (!chipText.includes('document')) throw new Error('chip does not label the file as a document: ' + chipText);
  checks.push('drop stages a document chip');

  // Dropping an unsupported binary stages nothing and says so honestly.
  const dtExe = new DataTransfer();
  dtExe.items.add(new File([new Uint8Array([77, 90, 0, 3, 0, 0])], 'evil.exe', { type: '' }));
  window.dispatchEvent(new DragEvent('drop', { dataTransfer: dtExe, bubbles: true }));
  await sleep(400);
  if ((row.innerText || '').includes('evil.exe')) throw new Error('unsupported binary was staged as a chip');
  const statusText = document.getElementById('status-line').textContent || '';
  if (!statusText.includes('evil.exe')) throw new Error('unsupported drop produced no honest status note: ' + statusText);
  checks.push('unsupported binary refused with a named status note');

  // Escape cancels a hovering drag overlay.
  const dt2 = new DataTransfer();
  dt2.items.add(new File(['x'], 'a.txt', { type: 'text/plain' }));
  window.dispatchEvent(new DragEvent('dragenter', { dataTransfer: dt2, bubbles: true }));
  await sleep(80);
  if (overlay.classList.contains('hidden')) throw new Error('overlay did not re-show on second dragenter');
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await sleep(80);
  if (!overlay.classList.contains('hidden')) throw new Error('Escape did not cancel the overlay');
  checks.push('Escape cancels the drop overlay');

  // Chips are removable.
  for (const btn of row.querySelectorAll('.attach-remove')) btn.click();
  await sleep(80);
  if ((row.innerText || '').includes('dropped-note.txt')) throw new Error('chip remove button failed');
  if (!row.classList.contains('hidden')) throw new Error('chips row did not hide when emptied');
  checks.push('chips removable; row hides when empty');
  return checks;
})()
`;

// v0.4.0: Loops + SOP end-to-end in the real app (mock mode). Runs after
// ATTACH_SCRIPT. Throws (failing the smoke) on the first violation.
const LOOPS_SCRIPT = `
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const checks = [];
  if (!window.MuseLoopsCore) throw new Error('window.MuseLoopsCore missing — src/loopsCore.js did not load');
  if (!window.MuseLoopRunner) throw new Error('window.MuseLoopRunner missing — src/loopRunner.js did not load');
  if (!window.MuseSopCore) throw new Error('window.MuseSopCore missing — src/sopCore.js did not load');
  checks.push('loops + sop core modules loaded in renderer');

  // Create a loop with three step types through the real IPC store.
  const created = await window.desktop.loopsCreate({
    name: 'Smoke loop',
    description: 'Built by the smoke test.',
    steps: [
      { type: 'note', text: 'smoke note' },
      { type: 'prompt', text: 'Say hello to the smoke test.' },
      { type: 'instruction', text: 'Press Done to finish the smoke loop.' }
    ]
  });
  if (!created.ok) throw new Error('loopsCreate failed: ' + created.error);
  checks.push('loop created through the real IPC store');

  // Open the Loops panel; the list shows the loop and the Night Queue
  // loop picker is populated. v0.4.2 regression: open Terminals FIRST
  // (the stacking case Kelly screenshotted) — clicking Loops must close
  // Terminals, put Loops at the TOP of the main column (directly under
  // the chat header, before the messages), step the chat aside and give
  // the panel the full height instead of the 46vh drawer cap.
  document.getElementById('toggle-terminals').click();
  await sleep(300);
  if (document.getElementById('terminals-panel').classList.contains('hidden')) throw new Error('terminals panel did not open (precondition)');
  document.getElementById('toggle-loops').click();
  await sleep(500);
  const panel = document.getElementById('loops-panel');
  if (panel.classList.contains('hidden')) throw new Error('loops panel did not open');
  if (!document.getElementById('terminals-panel').classList.contains('hidden')) throw new Error('v0.4.2: opening Loops did not close Terminals — Loops would stack underneath it');
  if (!document.getElementById('main').classList.contains('loops-open')) throw new Error('v0.4.2: <main> is not in loops-open mode');
  if (getComputedStyle(document.getElementById('messages')).display !== 'none') throw new Error('v0.4.2: chat messages did not step aside while Loops is open');
  const headerBottom = document.getElementById('chat-header').getBoundingClientRect().bottom;
  const panelR = panel.getBoundingClientRect();
  if (Math.abs(panelR.top - headerBottom) > 2) throw new Error('v0.4.2: Loops panel is not at the top (top=' + Math.round(panelR.top) + ', header bottom=' + Math.round(headerBottom) + ')');
  if (panelR.height <= window.innerHeight * 0.46) throw new Error('v0.4.2: Loops panel is still capped like a drawer (height=' + Math.round(panelR.height) + ' of viewport ' + window.innerHeight + ')');
  checks.push('v0.4.2: Loops opens at the top, full-height, Terminals closed, chat stepped aside');
  if (!document.getElementById('loops-list-view').innerText.includes('Smoke loop')) throw new Error('loop missing from the list view');
  const nightSel = document.getElementById('night-loop-select');
  if (![...nightSel.options].some((o) => o.value === created.loop.id)) throw new Error('night queue loop picker not populated');
  checks.push('loops panel lists the loop; night-queue loop picker populated');

  // Builder: open the loop, reorder step 1 down, save.
  openLoopBuilder(created.loop);
  await sleep(500);
  let stepCards = document.querySelectorAll('#loops-builder-view .loop-step');
  if (stepCards.length !== 3) throw new Error('builder did not render 3 step cards (got ' + stepCards.length + ')');
  const firstType = () => document.querySelector('#loops-builder-view .loop-step .loop-step-head select').value;
  if (firstType() !== 'note') throw new Error('first step should start as note, got ' + firstType());
  const headBtns = stepCards[0].querySelectorAll('.loop-step-head button');
  headBtns[1].click(); // the down button (up is disabled at index 0)
  await sleep(500);
  if (firstType() !== 'prompt') throw new Error('reorder failed: first step is ' + firstType());
  checks.push('builder renders steps; reorder works');
  const saveBtn = [...document.querySelectorAll('#loops-builder-view button')].find((b) => b.textContent.includes('Save loop'));
  if (!saveBtn) throw new Error('builder Save button missing');
  saveBtn.click();
  await sleep(500);
  checks.push('builder saved the reordered loop');

  // Run it in mock mode: prompt answers, instruction waits for Done.
  const runBtn = [...document.querySelectorAll('#loops-list-view button')].find((b) => b.textContent.includes('Run'));
  if (!runBtn) throw new Error('list Run button missing');
  runBtn.click();
  await sleep(600);
  let doneBtn = null;
  for (let i = 0; i < 30 && !doneBtn; i++) {
    doneBtn = [...document.querySelectorAll('#loops-run-view button')].find((b) => b.textContent.includes('Done'));
    if (!doneBtn) await sleep(300);
  }
  if (!doneBtn) throw new Error('instruction step never asked for its Done tap');
  doneBtn.click();
  let runStatus = '';
  for (let i = 0; i < 30; i++) {
    await sleep(300);
    runStatus = document.querySelector('#loops-run-view .drawer-sub') ? document.querySelector('#loops-run-view .drawer-sub').textContent : '';
    if (runStatus.includes('Run done')) break;
  }
  if (!runStatus.includes('Run done')) throw new Error('loop run did not finish done: ' + runStatus);
  const icons = [...document.querySelectorAll('#loops-run-view .loop-step-icon')].map((el) => el.textContent);
  if (icons.length !== 3 || icons.some((t) => t !== '✓')) throw new Error('checklist icons wrong: ' + icons.join(','));
  checks.push('loop ran to completion in mock mode (prompt + instruction via Done tap)');

  // SOP circuit: stage the fixture video (bytes are NOT a real video),
  // generate a labeled mock SOP from a transcript, convert to a Loop,
  // export — and the frame sampler must fail honestly on the fixture.
  const staged = await window.desktop.videoStageFile(window.__SMOKE_VIDEO_PATH);
  if (!staged.ok) throw new Error('videoStageFile failed: ' + staged.error);
  if (!staged.record.stagedId) throw new Error('intake record carries no stagedId');
  checks.push('video file staged via streamed copy; intake record created');
  const gen = await window.desktop.sopGenerate({
    recordId: staged.record.id, frames: [],
    transcriptText: 'Open the app. Click Fills. Save the form.'
  });
  if (!gen.ok) throw new Error('sopGenerate failed: ' + gen.error);
  if (gen.mode !== 'mock') throw new Error('expected the mock SOP path in smoke, got mode ' + gen.mode);
  if (gen.record.status !== 'generated' || !gen.record.markdown.includes('SOP')) throw new Error('generated SOP record incomplete');
  checks.push('mock SOP generated from transcript, saved with markdown');
  let samplerFailed = false;
  try { await sampleVideoFrames('muse-video://local/' + staged.record.stagedId); } catch (_) { samplerFailed = true; }
  if (!samplerFailed) throw new Error('frame sampler should fail honestly on a non-video fixture');
  checks.push('frame sampler fails honestly on an unreadable video (no faked frames)');
  const conv = await window.desktop.sopToLoop(staged.record.id);
  if (!conv.ok) throw new Error('sopToLoop failed: ' + conv.error);
  if (!conv.loop.name.includes('(from SOP)')) throw new Error('converted loop misnamed: ' + conv.loop.name);
  const exported = await window.desktop.sopsExport(staged.record.id);
  if (!exported.ok) throw new Error('sopsExport failed: ' + exported.error);
  checks.push('SOP converted into a draft Loop and exported to the Outbox');
  return checks;
})()
`;

// v0.4.1: Ask Muse — the no-token draft circuit in the real app.
// No GitHub token exists in the smoke userData, so Send must produce an
// honest local draft (never a fake send), the draft card must carry the
// "add your token" note + Copy fallback, and the Settings token field
// must round-trip through the real store (hasGithubToken boolean only).
const REQUESTS_SCRIPT = `
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const checks = [];
  if (!window.MuseRequestsCore) throw new Error('window.MuseRequestsCore missing — src/requestsCore.js did not load');
  checks.push('requests core module loaded in renderer');

  const pub0 = await window.desktop.getSettings();
  if (pub0.hasGithubToken !== false) throw new Error('fresh smoke profile should have no GitHub token');
  checks.push('settings report hasGithubToken=false at first run');

  document.getElementById('toggle-requests').click();
  await sleep(600);
  const panel = document.getElementById('requests-panel');
  if (panel.classList.contains('hidden')) throw new Error('requests panel did not open');
  checks.push('Ask Muse panel opens');

  const typeEl = document.getElementById('requests-type');
  typeEl.value = 'feature';
  const textEl = document.getElementById('requests-text');
  textEl.value = 'Smoke: please add a dark mode toggle';
  document.getElementById('requests-send').click();
  let listText = '';
  for (let i = 0; i < 20; i++) {
    await sleep(300);
    listText = document.getElementById('requests-list').innerText || '';
    if (listText.includes('dark mode')) break;
  }
  if (!listText.includes('dark mode')) throw new Error('draft request did not render: ' + listText);
  if (!listText.includes('Draft')) throw new Error('draft status chip missing: ' + listText);
  if (!listText.includes('Add your GitHub token in Settings')) throw new Error('honest no-token note missing: ' + listText);
  if (!listText.includes('Copy request text')) throw new Error('copy fallback button missing');
  if (textEl.value !== '') throw new Error('composer did not clear after save');
  checks.push('no-token Send saves an honest draft card (note + copy fallback, no fake send)');

  // Settings token round-trip through the real store: boolean only.
  await window.desktop.saveSettings({ githubToken: 'smoke-fake-gh-token' });
  const pub1 = await window.desktop.getSettings();
  if (pub1.hasGithubToken !== true) throw new Error('hasGithubToken did not flip true after save');
  checks.push('GitHub token saves (hasGithubToken=true, value never rendered back)');
  await window.desktop.clearGithubToken();
  const pub2 = await window.desktop.getSettings();
  if (pub2.hasGithubToken !== false) throw new Error('hasGithubToken did not flip back after clear');
  checks.push('GitHub token clears');

  document.getElementById('close-requests').click();
  return checks;
})()
`;

// v0.3.2: small-viewport panel layout assertions. Run after PAGE_SCRIPT at
// each window size; throws (failing the smoke) on the first violation.
const LAYOUT_SCRIPT = `
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const checks = [];
  const inView = (r) => r.top >= -1 && r.left >= -1 && r.bottom <= window.innerHeight + 1 && r.right <= window.innerWidth + 1;
  const scrollable = (el, name) => {
    const oy = getComputedStyle(el).overflowY;
    if (oy !== 'auto' && oy !== 'scroll') throw new Error(name + ' overflow-y is ' + oy + ' (expected auto/scroll)');
  };

  // --- Settings modal: card fits, body scrolls, Save pinned in viewport ---
  document.getElementById('open-settings').click();
  await sleep(500);
  const card = document.querySelector('#settings-modal .modal-card');
  const sBody = document.querySelector('#settings-modal .modal-body');
  const save = document.getElementById('save-settings');
  const cardR = card.getBoundingClientRect();
  if (!inView(cardR)) throw new Error('settings card clipped: top=' + Math.round(cardR.top) + ' bottom=' + Math.round(cardR.bottom) + ' viewport=' + window.innerWidth + 'x' + window.innerHeight);
  checks.push('settings card inside viewport (bottom ' + Math.round(cardR.bottom) + ' of ' + window.innerHeight + ')');
  scrollable(sBody, 'settings .modal-body');
  const saveR = save.getBoundingClientRect();
  if (!inView(saveR)) throw new Error('Save button outside viewport: bottom=' + Math.round(saveR.bottom) + ' viewport height=' + window.innerHeight);
  checks.push('Save button inside viewport');
  if (sBody.scrollHeight <= sBody.clientHeight) throw new Error('settings body does not overflow at this size (scrollHeight ' + sBody.scrollHeight + ' <= clientHeight ' + sBody.clientHeight + ') - scroll test would be vacuous');
  sBody.scrollTop = 99999;
  await sleep(80);
  if (sBody.scrollTop <= 0) throw new Error('settings body scrollTop did not advance (stuck at ' + sBody.scrollTop + ')');
  checks.push('settings body scrolls (scrollTop=' + Math.round(sBody.scrollTop) + ' of ' + sBody.scrollHeight + ')');
  const saveR2 = save.getBoundingClientRect();
  if (Math.abs(saveR2.bottom - saveR.bottom) > 1 || Math.abs(saveR2.top - saveR.top) > 1) throw new Error('Save button moved while the settings body scrolled - footer is not pinned');
  checks.push('Save footer pinned while body scrolls');
  document.getElementById('close-settings').click();
  await sleep(250);

  // --- Drawers: head pinned + visible, body region scrolls ---
  const drawers = [
    { open: 'toggle-audits', panel: 'audits-panel', close: 'close-audits', name: 'Audits' },
    { open: 'toggle-vault', panel: 'vault-panel', close: 'close-vault', name: 'Vault' },
    { open: 'toggle-terminals', panel: 'terminals-panel', close: 'close-terminals', name: 'Terminals' },
    { open: 'toggle-loops', panel: 'loops-panel', close: 'close-loops', name: 'Loops' },
    { open: 'toggle-requests', panel: 'requests-panel', close: 'close-requests', name: 'Ask Muse' },
    { open: 'toggle-night', panel: 'night-panel', close: 'close-night', name: 'Night Queue' }
  ];
  for (const d of drawers) {
    document.getElementById(d.open).click();
    await sleep(350);
    const panel = document.getElementById(d.panel);
    const body = panel.querySelector('.drawer-body');
    if (!body) throw new Error(d.name + ' panel has no .drawer-body');
    scrollable(body, d.name + ' .drawer-body');
    const headR = panel.querySelector('.drawer-head').getBoundingClientRect();
    if (!(headR.top >= -1 && headR.bottom <= window.innerHeight + 1)) throw new Error(d.name + ' drawer head outside viewport: top=' + Math.round(headR.top) + ' bottom=' + Math.round(headR.bottom));
    if (d.panel === 'night-panel') {
      const apR = document.getElementById('night-approve').getBoundingClientRect();
      if (!inView(apR)) throw new Error('Night Queue Approve row outside viewport: bottom=' + Math.round(apR.bottom) + ' viewport height=' + window.innerHeight);
    }
    checks.push(d.name + ' drawer: head visible, body overflow-y auto');
    document.getElementById(d.close).click();
    await sleep(200);
  }
  return checks;
})()
`;

app.whenReady().then(async () => {
  const deadline = Date.now() + 30000;
  let win = null;
  while (Date.now() < deadline) {
    win = BrowserWindow.getAllWindows()[0];
    if (win) break;
    await new Promise((r) => setTimeout(r, 300));
  }
  if (!win) { console.log('SMOKE FAIL: no window'); app.exit(1); return; }
  // Give the renderer's init a moment to finish.
  await new Promise((r) => setTimeout(r, 2500));
  try {
    const result = await win.webContents.executeJavaScript(PAGE_SCRIPT);
    for (const s of result.steps || []) console.log('  ✓', s);
    if (!result.ok) {
      console.log('SMOKE FAIL:', result.error);
      app.exit(1);
      return;
    }
    // v0.3.4: attachment UX (classifier in page, hidden native input,
    // overlay show/Escape, simulated drop staging + chip removal).
    const attachChecks = await win.webContents.executeJavaScript(ATTACH_SCRIPT);
    for (const c of attachChecks) console.log('  ✓', c);
    // v0.4.0: Loops + SOP circuit. The fixture "video" is deliberately
    // not a real video: staging must still work (streamed copy is
    // content-agnostic) and the sampler must fail honestly on it.
    const fixtureVideo = path.join(tmp, 'smoke-clip.mp4');
    fs.writeFileSync(fixtureVideo, Buffer.from('not-a-real-video-fixture'));
    await win.webContents.executeJavaScript(`window.__SMOKE_VIDEO_PATH = ${JSON.stringify(fixtureVideo)}; true;`);
    const loopChecks = await win.webContents.executeJavaScript(LOOPS_SCRIPT);
    for (const c of loopChecks) console.log('  ✓', c);
    // v0.4.1: Ask Muse no-token draft circuit + token settings round-trip.
    const reqChecks = await win.webContents.executeJavaScript(REQUESTS_SCRIPT);
    for (const c of reqChecks) console.log('  ✓', c);
    // The fake token the page saved must be encrypted at rest, never plaintext.
    const settingsOnDisk = fs.readFileSync(path.join(tmp, 'settings.json'), 'utf8');
    if (settingsOnDisk.includes('smoke-fake-gh-token')) {
      console.log('SMOKE FAIL: settings.json contains the GitHub token in plaintext');
      app.exit(1);
      return;
    }
    console.log('  ✓ settings.json holds no plaintext GitHub token');
    // v0.3.2: panel layout at desktop and small/scaled window sizes.
    for (const [w, h] of [[1280, 720], [1024, 640]]) {
      win.setSize(w, h);
      await new Promise((r) => setTimeout(r, 600));
      const checks = await win.webContents.executeJavaScript(LAYOUT_SCRIPT);
      for (const c of checks) console.log('  ✓ [' + w + 'x' + h + ']', c);
    }
    console.log('SMOKE PASS');
    app.exit(0);
  } catch (err) {
    console.log('SMOKE FAIL:', err.message);
    app.exit(1);
  }
});
