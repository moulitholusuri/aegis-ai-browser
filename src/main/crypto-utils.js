'use strict';
// Core cryptography: scrypt key derivation, AES-256-GCM, RFC 6238 TOTP
// (the standard implemented by Google Authenticator), RFC 4648 base32.

const crypto = require('crypto');

const SCRYPT = { N: 1 << 15, r: 8, p: 1, keylen: 64, maxmem: 96 * 1024 * 1024 };

// One scrypt pass -> 64 bytes: [0..32) = verifier, [32..64) = key-encryption key
function deriveKeys(passphrase, saltBuf) {
  const buf = crypto.scryptSync(Buffer.from(String(passphrase), 'utf8'), saltBuf, SCRYPT.keylen, {
    N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: SCRYPT.maxmem,
  });
  return { verifier: buf.subarray(0, 32), kek: Buffer.from(buf.subarray(32, 64)) };
}

function encrypt(kek, plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', kek, iv);
  const ct = Buffer.concat([cipher.update(Buffer.from(plaintext)), cipher.final()]);
  return {
    iv: iv.toString('base64'),
    ct: ct.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
  };
}

function decrypt(kek, obj) {
  const d = crypto.createDecipheriv('aes-256-gcm', kek, Buffer.from(obj.iv, 'base64'));
  d.setAuthTag(Buffer.from(obj.tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(obj.ct, 'base64')), d.final()]);
}

// ---- TOTP (Google Authenticator compatible): HMAC-SHA1, 6 digits, 30s ----

function hotp(secret, counter) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', secret).update(buf).digest();
  const o = h[19] & 0x0f;
  const code = (((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3]) % 1e6;
  return String(code).padStart(6, '0');
}

function totp(secret, at = Date.now(), step = 30) {
  return hotp(secret, Math.floor(at / 1000 / step));
}

function verifyTotp(secret, code, window = 1) {
  const c = String(code || '').trim();
  if (!/^\d{6}$/.test(c)) return false;
  const counter = Math.floor(Date.now() / 1000 / 30);
  for (let w = -window; w <= window; w++) {
    if (hotp(secret, counter + w) === c) return true; // ±1 step clock drift
  }
  return false;
}

// ---- base32 (no padding, as expected by authenticator apps) ----

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function b32encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

function b32decode(str) {
  const clean = String(str).toUpperCase().replace(/=+$/g, '').replace(/\s/g, '');
  let bits = 0, value = 0;
  const out = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx === -1) throw new Error('Invalid base32 character');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

module.exports = {
  deriveKeys, encrypt, decrypt,
  hotp, totp, verifyTotp,
  b32encode, b32decode,
};
