'use strict';

// Vault crypto tests — fake secrets only.
// Run: node tests/vault.test.js

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Vault, VaultError } = require('../src/vault');

const MASTER = 'correct horse battery staple';
const FAKE_PW = 'Fake!Pass-98765';
const FAKE_TOTP = 'JBSWY3DPEHPK3PXP';

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-vault-'));
  const file = path.join(dir, 'vault.json');

  // Create + add entries.
  const v1 = new Vault(file);
  assert.strictEqual(v1.exists(), false);
  await assert.rejects(() => v1.create('short'), /at least 8/, 'weak master password rejected');
  const created = await v1.create(MASTER);
  assert.strictEqual(created.unlocked, true);
  await assert.rejects(() => v1.create(MASTER), /already exists/, 'second create rejected');

  await v1.addEntry({
    label: 'Test Bank', username: 'mike-test', password: FAKE_PW,
    totpSecret: FAKE_TOTP, url: 'https://example-bank.test', targetTitle: 'Test Bank — Sign in', notes: 'fake'
  });
  await v1.addEntry({ label: 'Plain Site', username: 'mike2', password: 'OtherFake!1' });
  await assert.rejects(
    () => v1.addEntry({ label: 'test bank', username: 'x', password: 'y' }),
    /already exists/, 'duplicate label rejected (case-insensitive)'
  );

  // The file on disk is ciphertext: no plaintext secret, username, or label.
  const rawFile = fs.readFileSync(file, 'utf8');
  for (const probe of [FAKE_PW, FAKE_TOTP, 'mike-test', 'Test Bank', MASTER]) {
    assert.ok(!rawFile.includes(probe), `vault file must not contain plaintext: ${probe}`);
  }

  // Public views carry no secret material at all.
  const pub = JSON.stringify(v1.listPublic());
  assert.ok(!pub.includes(FAKE_PW) && !pub.includes(FAKE_TOTP), 'listPublic has no secrets');
  const planning = v1.listForPlanning();
  assert.deepStrictEqual(Object.keys(planning[0]).sort(), ['label', 'username'], 'planning view = label+username ONLY');

  // Secret accessors work while unlocked (main-process only).
  const login = v1.getLoginSecret('test bank');
  assert.strictEqual(login.password, FAKE_PW, 'login secret roundtrip');
  assert.strictEqual(login.targetTitle, 'Test Bank — Sign in');
  assert.strictEqual(v1.getTotpSecret('Test Bank'), FAKE_TOTP, 'totp secret roundtrip');

  // CRUD update + delete.
  const [first] = v1.listPublic();
  await v1.updateEntry(first.id, { notes: 'updated note' });
  assert.strictEqual(v1.reveal(first.id, 'password'), FAKE_PW, 'update without password keeps the secret');
  await v1.deleteEntry(first.id);
  assert.strictEqual(v1.listPublic().length, 1, 'delete works');

  // Lock: everything secret-shaped closes.
  v1.lock();
  assert.strictEqual(v1.isUnlocked(), false);
  assert.strictEqual(v1.getLoginSecret('Plain Site'), null, 'locked vault yields no login secret');
  assert.deepStrictEqual(v1.listForPlanning(), [], 'locked vault yields no planning entries');
  assert.throws(() => v1.listPublic(), (e) => e instanceof VaultError && e.code === 'LOCKED');

  // Wrong master password fails cleanly.
  const v2 = new Vault(file);
  await assert.rejects(
    () => v2.unlock('definitely the wrong password'),
    (e) => e instanceof VaultError && e.code === 'WRONG_PASSWORD',
    'wrong master password -> WRONG_PASSWORD'
  );
  assert.strictEqual(v2.isUnlocked(), false, 'still locked after wrong password');

  // Correct password reopens with data intact.
  await v2.unlock(MASTER);
  assert.strictEqual(v2.getLoginSecret('Plain Site').password, 'OtherFake!1', 'reopen roundtrip');

  // Tampered ciphertext fails authentication.
  const tampered = JSON.parse(fs.readFileSync(file, 'utf8'));
  const ct = Buffer.from(tampered.ciphertext, 'base64');
  ct[0] = ct[0] ^ 0xff;
  tampered.ciphertext = ct.toString('base64');
  fs.writeFileSync(file, JSON.stringify(tampered), 'utf8');
  const v3 = new Vault(file);
  await assert.rejects(
    () => v3.unlock(MASTER),
    (e) => e instanceof VaultError && e.code === 'WRONG_PASSWORD',
    'tampered vault file -> decryption failure'
  );

  console.log('vault.test.js: ALL PASS');
})().catch((err) => { console.error(err); process.exit(1); });
