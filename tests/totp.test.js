'use strict';

// TOTP tests. Proof strategy:
//  - RFC 4226 Appendix D official HOTP vectors (counters 0–9) exercise the
//    exact same HMAC-SHA1 + dynamic-truncation core RFC 6238 uses — our
//    totp(seed, counter*30) must reproduce all ten.
//  - RFC 6238 rows that verify against the algorithm (59, 1234567890,
//    2000000000 → 94287082 / 89005924 / 69279037 in 8 digits).
//  - The remaining classic timestamps use values cross-verified against two
//    independent implementations (Node crypto + Python hashlib, identical
//    output) — 1111111109 → 07081804, 1111111111 → 14050471,
//    20000000000 → 65353130 (8 digits).
// Run: node tests/totp.test.js

const assert = require('assert');
const { base32Decode, base32Encode, totp } = require('../src/totp');

// RFC seed (SHA-1): ASCII "12345678901234567890".
const seedAscii = Buffer.from('12345678901234567890', 'ascii');
const seedBase32 = base32Encode(seedAscii);
assert.strictEqual(seedBase32, 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', 'base32 encode of RFC seed');
assert.deepStrictEqual(base32Decode(seedBase32), seedAscii, 'base32 roundtrip');

// RFC 4226 official vectors, counters 0..9 (6 digits — exactly our format).
const hotpVectors = ['755224', '287082', '359152', '969429', '338314', '254676', '287922', '162583', '399871', '520489'];
hotpVectors.forEach((expected, counter) => {
  assert.strictEqual(totp(seedBase32, counter * 30), expected, `RFC 4226 counter ${counter}`);
});

// RFC 6238 timestamps: [timeSeconds, expected 6-digit code]
const totpVectors = [
  [59, '287082'],          // RFC 8-digit 94287082
  [1111111109, '081804'],  // cross-verified 07081804
  [1111111111, '050471'],  // cross-verified 14050471
  [1234567890, '005924'],  // RFC 8-digit 89005924
  [2000000000, '279037'],  // RFC 8-digit 69279037
  [20000000000, '353130']  // cross-verified 65353130
];
for (const [t, six] of totpVectors) {
  const code = totp(seedBase32, t);
  assert.strictEqual(code, six, `TOTP at ${t}: expected ${six}, got ${code}`);
  assert.match(code, /^\d{6}$/, 'code is exactly 6 digits');
}

// base32 tolerance: lowercase, spaces, padding must not change the bytes.
assert.deepStrictEqual(
  base32Decode('jbsw y3dp ehpk 3pxp'),
  base32Decode('JBSWY3DPEHPK3PXP'),
  'base32 decode is case/space tolerant'
);
assert.throws(() => base32Decode('NOT!BASE32'), /Invalid base32/, 'invalid chars rejected');
assert.throws(() => totp(''), /empty/, 'empty secret rejected');

// Live generation returns a 6-digit string.
assert.match(totp('JBSWY3DPEHPK3PXP'), /^\d{6}$/, 'live code format');

console.log('totp.test.js: ALL PASS (RFC 4226 x10 + RFC 6238 x6)');
