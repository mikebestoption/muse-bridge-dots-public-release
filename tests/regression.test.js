'use strict';

// v0.1 regression checks — the Vault release must not break what shipped.
// Run: node tests/regression.test.js

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createSettingsStore } = require('../src/settingsStore');
const { executeAction, describeAction, ACTION_TYPES } = require('../src/taskEngine');
const { mockReply } = require('../src/mockBrain');
const dotTests = require('../src/dotTests');
const nightQueue = require('../src/nightQueue');
const audit = require('../src/audit');

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-regression-'));

  // Settings store: defaults + persistence (+ new vault auto-lock setting).
  const store = createSettingsStore(dir, null, path.join(dir, 'bridge'));
  let pub = store.getPublicSettings();
  assert.strictEqual(pub.vaultAutoLockMinutes, 10, 'auto-lock default is 10 minutes');
  assert.strictEqual(pub.hasKey, false);
  store.save({ vaultAutoLockMinutes: 25 });
  assert.strictEqual(store.getPublicSettings().vaultAutoLockMinutes, 25, 'auto-lock setting persists');

  // v0.3 hands-guard settings: defaults + persistence.
  assert.strictEqual(pub.handsIdleThresholdSeconds, 30, 'hands idle threshold default is 30 s');
  assert.strictEqual(pub.handsMaxWaitMinutes, 30, 'hands max wait default is 30 min');
  store.save({ handsIdleThresholdSeconds: 60, handsMaxWaitMinutes: 15 });
  pub = store.getPublicSettings();
  assert.strictEqual(pub.handsIdleThresholdSeconds, 60, 'hands idle threshold persists');
  assert.strictEqual(pub.handsMaxWaitMinutes, 15, 'hands max wait persists');

  // Task engine: old actions intact, new actions registered.
  for (const t of ['open_url', 'open_app', 'list_folder', 'create_file', 'append_to_file', 'run_command', 'copy_from_app', 'paste_to_app']) {
    assert.ok(ACTION_TYPES.includes(t), `v0.1 action ${t} still registered`);
  }
  for (const t of ['fill_login', 'fill_totp', 'wait_for_user']) {
    assert.ok(ACTION_TYPES.includes(t), `v0.2 action ${t} registered`);
  }
  const rejected = await executeAction({ type: 'nonsense' }, { shell: {}, homePath: dir });
  assert.strictEqual(rejected.ok, false, 'unknown action rejected');
  const listing = await executeAction({ type: 'list_folder', path: dir }, { shell: {}, homePath: dir });
  assert.strictEqual(listing.ok, true, 'list_folder still works');

  // Mock brain: v0.1 proposals + new fill proposals parse out of the reply.
  function actionsOf(reply) {
    const m = reply.match(/```actions\s*([\s\S]*?)```/);
    return m ? JSON.parse(m[1]) : [];
  }
  assert.strictEqual(actionsOf(mockReply('list my Downloads folder', dir))[0].type, 'list_folder');
  assert.strictEqual(actionsOf(mockReply('fill the login for GitHub', dir))[0].type, 'fill_login');
  assert.strictEqual(actionsOf(mockReply('fill the login for GitHub', dir))[0].entryLabel, 'GitHub');
  assert.strictEqual(actionsOf(mockReply('enter the authenticator code for GitHub', dir))[0].type, 'fill_totp');
  assert.strictEqual(actionsOf(mockReply('log in to Twilio', dir))[0].type, 'fill_login');

  // Dot verdict parsing unchanged.
  const verdicts = dotTests.parseVerdicts('CLAIM: totals add up | RESULT: PASS | EVIDENCE: summed twice\nCLAIM: date correct | RESULT: FAIL | EVIDENCE: off by one day');
  assert.strictEqual(verdicts.length, 2);
  assert.strictEqual(verdicts[1].result, 'FAIL');

  // Night summary: parked jobs counted + reasons listed (v0.2 change).
  const bridgeDir = path.join(dir, 'bridge');
  const s = await nightQueue.writeNightSummary(bridgeDir, [
    { type: 'chat', text: 'do a thing', status: 'done', note: '' },
    { type: 'chat', text: 'touch the key', status: 'waiting_on_user', parkReason: 'hardware security key touch needed' }
  ]);
  assert.strictEqual(s.counts.waiting_on_user, 1, 'summary counts waiting_on_user');
  const body = fs.readFileSync(s.path, 'utf8');
  assert.ok(body.includes('Parked — waiting on you'), 'summary has parked section');
  assert.ok(body.includes('hardware security key touch needed'), 'summary lists park reason');

  // Audit signal unchanged.
  const item = audit.newAuditItem({ title: 'X', kind: 'chat', content: 'y' });
  assert.strictEqual(audit.waitingCount([item]), 1);

  console.log('regression.test.js: ALL PASS');
})().catch((err) => { console.error(err); process.exit(1); });
