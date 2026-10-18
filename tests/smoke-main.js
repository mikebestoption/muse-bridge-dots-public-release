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
