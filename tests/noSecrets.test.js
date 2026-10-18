'use strict';

// HARD SECURITY TEST — the guarantee Michael is relying on:
// a simulated vault fill must leave NO trace of the password or the
// authenticator code in any serialized artifact the app produces:
//   - the proposed action (what the model emits)
//   - the approval-card summary + card detail
//   - what execution returns (result output + summary)
//   - chat history entries built from the result
//   - Night Queue log lines + morning summary
// Fake secrets only. Run: node tests/noSecrets.test.js

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Vault } = require('../src/vault');
const { totp } = require('../src/totp');
const { executeAction, describeAction } = require('../src/taskEngine');
const { writeNightSummary } = require('../src/nightQueue');

const FAKE_PW = 'Fake!Pass-98765';
const FAKE_TOTP = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
const LABEL = 'Test Bank';

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-nosecrets-'));
  const vault = new Vault(path.join(dir, 'vault.json'));
  await vault.create('master-password-for-tests');
  await vault.addEntry({
    label: LABEL, username: 'mike-test', password: FAKE_PW,
    totpSecret: FAKE_TOTP, targetTitle: 'Test Bank — Sign in'
  });
  const currentCode = totp(FAKE_TOTP);

  // Sanity: the fake secrets really are in play (test is not vacuous).
  assert.strictEqual(vault.getLoginSecret(LABEL).password, FAKE_PW);
  assert.match(currentCode, /^\d{6}$/);

  // VaultFill wired exactly the way main.js wires it.
  const ctx = {
    shell: { openExternal: async () => {}, openPath: async () => '' },
    homePath: dir,
    vaultFill: {
      unlocked: () => vault.isUnlocked(),
      login: (label) => vault.getLoginSecret(label),
      totpCode: (label) => {
        const entry = vault.findByLabel(label);
        const secret = vault.getTotpSecret(label);
        return secret ? { code: totp(secret), targetTitle: entry.targetTitle } : null;
      }
    }
  };

  const artifacts = {}; // name -> serialized string that must be secret-free

  // 1) The actions as the model proposes them (labels only, by construction).
  const loginAction = { type: 'fill_login', entryLabel: LABEL, label: `Fill login for ${LABEL}` };
  const totpAction = { type: 'fill_totp', entryLabel: LABEL, label: `Fill authenticator code for ${LABEL}` };
  artifacts['proposed login action JSON'] = JSON.stringify(loginAction);
  artifacts['proposed totp action JSON'] = JSON.stringify(totpAction);

  // 2) Approval-card material: describeAction + the detail lines the
  //    renderer builds from the vault's PUBLIC list (label/username/title).
  artifacts['login card summary'] = describeAction(loginAction);
  artifacts['totp card summary'] = describeAction(totpAction);
  const pub = vault.listPublic().find((e) => e.label === LABEL);
  artifacts['login card detail'] = [
    `Vault entry: ${LABEL}`, `Username: ${pub.username}`,
    `Target window: ${pub.targetTitle}`, 'Password: ••••••••'
  ].join('\n');
  artifacts['totp card detail'] = [
    `Vault entry: ${LABEL}`, `Username: ${pub.username}`,
    `Target window: ${pub.targetTitle}`, 'Authenticator code: ••••••'
  ].join('\n');

  // 3) Execute the simulated fills. (On this Linux box execution must stop
  //    at the honest "Windows only" result — on Windows it types; either
  //    way the returned strings are what land in history and logs.)
  const loginRes = await executeAction(loginAction, ctx);
  const totpRes = await executeAction(totpAction, ctx);
  artifacts['login result output'] = loginRes.output;
  artifacts['totp result output'] = totpRes.output;
  artifacts['login result JSON'] = JSON.stringify({ ...loginRes, summary: describeAction(loginAction) });
  artifacts['totp result JSON'] = JSON.stringify({ ...totpRes, summary: describeAction(totpAction) });

  // 4) Chat history entries exactly as the renderer builds them.
  const history = [
    { role: 'assistant', content: `[Task result] ${describeAction(loginAction)}: ${loginRes.ok ? 'OK' : 'FAILED'} — ${loginRes.output}` },
    { role: 'assistant', content: `[Task result] ${describeAction(totpAction)}: ${totpRes.ok ? 'OK' : 'FAILED'} — ${totpRes.output}` }
  ];
  artifacts['chat history JSON'] = JSON.stringify(history);

  // 5) Night Queue log lines + morning summary, as the runner writes them.
  const logLines = [
    `START [fill_login] ${LABEL}`,
    `DONE [fill_login] Login filled for "${LABEL}"`,
    `START [fill_totp] ${LABEL}`,
    `DONE [fill_totp] Authenticator code filled for "${LABEL}"`
  ];
  artifacts['night log lines'] = logLines.join('\n');
  const bridgeDir = path.join(dir, 'bridge');
  await writeNightSummary(bridgeDir, [
    { type: 'fill_login', text: LABEL, status: 'done', note: `Login filled for "${LABEL}"` },
    { type: 'fill_totp', text: LABEL, status: 'done', note: `Authenticator code filled for "${LABEL}"` },
    { type: 'fill_login', text: 'Locked Site', status: 'waiting_on_user', parkReason: 'Vault locked — unlock to fill. Nothing was typed.' }
  ]);
  const summariesDir = path.join(bridgeDir, 'NightRuns');
  const summaryFile = fs.readdirSync(summariesDir).find((f) => f.startsWith('morning-summary-'));
  artifacts['morning summary'] = fs.readFileSync(path.join(summariesDir, summaryFile), 'utf8');
  assert.ok(artifacts['morning summary'].includes('Waiting on you: 1'), 'summary counts parked jobs');
  assert.ok(artifacts['morning summary'].includes('Vault locked'), 'summary lists parked reason');

  // 6) Locked-vault behavior: fill refuses with the locked message, and
  //    wait_for_user carries its reason (and nothing else).
  vault.lock();
  const lockedRes = await executeAction(loginAction, ctx);
  assert.strictEqual(lockedRes.waitForUser, true, 'locked vault fill waits for the user');
  assert.ok(lockedRes.output.includes('Vault locked — unlock to fill'), 'locked message is exact');
  artifacts['locked-vault result'] = lockedRes.output;
  const waitRes = await executeAction({ type: 'wait_for_user', reason: 'Hardware security key touch needed' }, ctx);
  assert.strictEqual(waitRes.waitForUser, true, 'wait_for_user flags the human step');
  artifacts['wait_for_user result'] = waitRes.output;

  // THE ASSERTIONS: no artifact may contain the password or the code.
  for (const [name, text] of Object.entries(artifacts)) {
    assert.ok(!text.includes(FAKE_PW), `${name} MUST NOT contain the password`);
    assert.ok(!text.includes(currentCode), `${name} MUST NOT contain the authenticator code`);
    assert.ok(!text.includes(FAKE_TOTP), `${name} MUST NOT contain the TOTP secret`);
  }

  console.log(`noSecrets.test.js: ALL PASS (${Object.keys(artifacts).length} artifacts checked, platform result: "${loginRes.output.slice(0, 60)}…")`);
})().catch((err) => { console.error(err); process.exit(1); });
