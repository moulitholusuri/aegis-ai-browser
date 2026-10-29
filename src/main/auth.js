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
  async setup(passphrase) {
    if (this.state.configured) throw new Error('This browser is already configured.');
    if (!passphrase || String(passphrase).length < 8) {
      throw new Error('Passphrase must be at least 8 characters.');
    }
    const salt = crypto.randomBytes(16);
    const secret = crypto.randomBytes(20); // 160-bit TOTP secret
    const { verifier, kek } = deriveKeys(passphrase, salt);
    this._pending = { salt, secret, verifier, kek };

    const b32 = b32encode(secret);
    const otpauth = `otpauth://totp/${ISSUER}:you?secret=${b32}&issuer=${ISSUER}&algorithm=SHA1&digits=6&period=30`;
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
      v: 1,
      configured: true,
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

  // Sign-in: passphrase proves identity, TOTP code is the second factor.
  login(passphrase, code) {
    if (!this.state.configured) throw new Error('Not configured yet.');
    const salt = Buffer.from(this.state.salt, 'base64');
    const { verifier, kek } = deriveKeys(passphrase, salt);
    const expected = Buffer.from(this.state.verifier, 'base64');
    if (verifier.length !== expected.length || !crypto.timingSafeEqual(verifier, expected)) {
      throw new Error('Wrong passphrase.');
    }
    let secret;
    try {
      secret = decrypt(kek, this.state.wrappedTotp);
    } catch {
      throw new Error('Vault is corrupt or was tampered with.');
    }
    if (!verifyTotp(secret, code)) throw new Error('Invalid authenticator code.');
    this.dek = decrypt(kek, this.state.wrappedDek);
    return true;
  }

  lock() {
    if (this.dek) { this.dek.fill(0); this.dek = null; }
  }

  wipe() {
    this.lock();
    this._pending = null;
    try { fs.rmSync(this.file, { force: true }); } catch { /* ignore */ }
  }
}

module.exports = { AuthVault };
