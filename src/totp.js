'use strict';

// TOTP (RFC 6238) — Google Authenticator compatible.
// HMAC-SHA1, 30-second step, 6 digits, secret as base32 (RFC 4648).
// This module runs in the Electron MAIN process only: codes are generated
// locally, at the moment they are needed, and are never stored anywhere.

const crypto = require('crypto');

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

// Decode a base32 string (tolerant of lowercase, spaces, dashes, padding).
function base32Decode(input) {
  const clean = String(input || '').toUpperCase().replace(/[\s=-]+/g, '');
  let bits = 0;
  let bitsCount = 0;
  const out = [];
  for (const ch of clean) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx === -1) throw new Error(`Invalid base32 character: "${ch}"`);
    bits = (bits << 5) | idx;
    bitsCount += 5;
    if (bitsCount >= 8) {
      bitsCount -= 8;
      out.push((bits >> bitsCount) & 0xff);
    }
  }
  return Buffer.from(out);
}

function base32Encode(buffer) {
  let bits = 0;
  let bitsCount = 0;
  let out = '';
  for (const byte of buffer) {
    bits = (bits << 8) | byte;
    bitsCount += 8;
    while (bitsCount >= 5) {
      bitsCount -= 5;
      out += BASE32_ALPHABET[(bits >> bitsCount) & 0x1f];
    }
  }
  if (bitsCount > 0) out += BASE32_ALPHABET[(bits << (5 - bitsCount)) & 0x1f];
  return out;
}

// Generate the current TOTP code for a base32 secret.
// `timeSeconds` is injectable for testing only; production callers omit it
// so the code is always generated at execution moment.
function totp(secretBase32, timeSeconds, { step = 30, digits = 6 } = {}) {
  const key = base32Decode(secretBase32);
  if (!key.length) throw new Error('TOTP secret is empty.');
  const t = typeof timeSeconds === 'number' ? timeSeconds : Math.floor(Date.now() / 1000);
  const counter = Math.floor(t / step);
  const counterBuf = Buffer.alloc(8);
  counterBuf.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac('sha1', key).update(counterBuf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  const code = binary % 10 ** digits;
  return String(code).padStart(digits, '0');
}

// Seconds left before the current code rolls over (for UI hints only).
function secondsRemaining(timeSeconds, step = 30) {
  const t = typeof timeSeconds === 'number' ? timeSeconds : Math.floor(Date.now() / 1000);
  return step - (t % step);
}

module.exports = { base32Decode, base32Encode, totp, secondsRemaining };
