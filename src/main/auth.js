'use strict';
// AuthVault: passphrase + Google Authenticator (TOTP) sign-in.
// The data-encryption key (DEK) that unlocks the history/secrets vault is only
// released after BOTH the passphrase and a valid TOTP code are presented.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const QRCode = require('qrcode');
const { deriveKeys, encrypt, decrypt, verifyTotp, b32encode } = require('./crypto-utils');

const ISSUER = 'Aegis';

// Display name for this profile. Not part of the key derivation — the vault key
// stays bound to the passphrase + TOTP secret, so changing the username can
// never lock anyone out of their encrypted history.
function normalizeUsername(username) {
  const raw = String(username == null ? '' : username).replace(/\s+/g, ' ').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9 ._-]{2,31}$/.test(raw)) {
    throw new Error('Username must be 3–32 characters: letters, numbers, spaces, dot, underscore or hyphen.');
  }
  return raw;
}

class AuthVault {
  constructor(file) {
    this.file = file;
    this.state = { configured: false };
    this.dek = null;         // only present while unlocked
    this._pending = null;    // in-memory setup state (never written to disk)
    this.load();
  }

  load() {
    try {
      this.state = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      this.state = { configured: false };
    }
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  isConfigured() { return !!this.state.configured; }
  isUnlocked() { return !!this.dek; }

  // Step 1 of enrollment: create TOTP secret + QR code for Google Authenticator.
  async setup(username, passphrase) {
    if (this.state.configured) throw new Error('This browser is already configured.');
    const name = normalizeUsername(username);
    if (!passphrase || String(passphrase).length < 8) {
      throw new Error('Passphrase must be at least 8 characters.');
    }
    const salt = crypto.randomBytes(16);
    const secret = crypto.randomBytes(20); // 160-bit TOTP secret
    const { verifier, kek } = deriveKeys(passphrase, salt);
    this._pending = { username: name, salt, secret, verifier, kek };

    const b32 = b32encode(secret);
    const otpauth = `otpauth://totp/${ISSUER}:${encodeURIComponent(name)}?secret=${b32}&issuer=${ISSUER}&algorithm=SHA1&digits=6&period=30`;
    const qr = await QRCode.toDataURL(otpauth, { margin: 1, width: 280, color: { dark: '#0b0f14', light: '#ffffff' } });
    return { secret: b32, otpauth, qr };
  }

  // Step 2: verify the first code to prove the app scanned correctly, then seal the vault.
  confirmSetup(code) {
    if (!this._pending) throw new Error('No setup in progress. Start again.');
    if (!verifyTotp(this._pending.secret, code)) {
      throw new Error('Invalid code. Check your authenticator app and try again.');
    }
    const dek = crypto.randomBytes(32);
    this.state = {
      v: 2,
      configured: true,
      username: this._pending.username,
      salt: this._pending.salt.toString('base64'),
      verifier: this._pending.verifier.toString('base64'),
      wrappedDek: encrypt(this._pending.kek, dek),
      wrappedTotp: encrypt(this._pending.kek, this._pending.secret),
      createdAt: Date.now(),
    };
    this.save();
    this._pending = null;
    this.dek = dek;
    return true;
  }

  // Sign-in: username label + passphrase + TOTP code. Every failure returns the
  // SAME message so an attacker can't learn which factor was wrong.
  login(username, passphrase, code) {
    if (!this.state.configured) throw new Error('Not configured yet.');
    const salt = Buffer.from(this.state.salt, 'base64');
    const { verifier, kek } = deriveKeys(passphrase, salt);
    const expected = Buffer.from(this.state.verifier, 'base64');
    const passOk = verifier.length === expected.length && crypto.timingSafeEqual(verifier, expected);
    const userOk = !this.state.username
      || String(username == null ? '' : username).trim().toLowerCase()
         === String(this.state.username).trim().toLowerCase();
    if (!passOk || !userOk) throw new Error('Credentials mismatching');
    let secret;
    try {
      secret = decrypt(kek, this.state.wrappedTotp);
    } catch {
      throw new Error('Vault is corrupt or was tampered with.');
    }
    if (!verifyTotp(secret, code)) throw new Error('Credentials mismatching');
    this.dek = decrypt(kek, this.state.wrappedDek);
    return true;
  }

  // Username is a display label (stored in clear next to the salt). Only the
  // unlocked owner can change it; the encryption keys are untouched.
  setUsername(username) {
    if (!this.dek) throw new Error('Unlock the browser before changing your username.');
    this.state.username = normalizeUsername(username);
    this.save();
    return this.state.username;
  }

  lock() {
    if (this.dek) { this.dek.fill(0); this.dek = null; }
  }

  wipe() {
    this.lock();
    this._pending = null;
    // Forgetting the in-memory state matters: the renderer reloads right after
    // a wipe, and a stale `configured: true` would bounce it back to the login
    // screen (and keep the old credentials valid until restart).
    this.state = { configured: false };
    try { fs.rmSync(this.file, { force: true }); } catch { /* ignore */ }
  }
}

module.exports = { AuthVault, normalizeUsername };
