'use strict';
// Auth unit tests: username labeling, identical failure message for every bad
// factor, and username edits that never touch the encryption keys.
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { AuthVault, normalizeUsername } = require('../src/main/auth');
const { b32decode, totp } = require('../src/main/crypto-utils');

let pass = 0, fail = 0;
const check = (name, fn) => {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.log(`  ✗ FAIL: ${name} — ${e.message}`); }
};

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-auth-'));
  const file = path.join(dir, 'auth.json');
  const PASS = 'correct horse battery';
  const USER = 'Test User';

  const a = new AuthVault(file);
  const { secret } = await a.setup(USER, PASS);
  const b32 = secret;
  const code = () => totp(b32decode(b32));
  a.confirmSetup(code());

  check('setup stores the username', () => assert.strictEqual(a.state.username, USER));
  check('normalizeUsername trims + collapses spaces', () => assert.strictEqual(normalizeUsername('  Test   User '), 'Test User'));
  check('normalizeUsername rejects short names', () => assert.throws(() => normalizeUsername('ab')));
  check('normalizeUsername rejects symbols', () => assert.throws(() => normalizeUsername('bad<script>')));

  const relogin = () => new AuthVault(file);

  check('wrong username → Credentials mismatching', () => {
    const v = relogin();
    assert.throws(() => v.login('Someone Else', PASS, code()), /Credentials mismatching/);
  });
  check('wrong passphrase → Credentials mismatching', () => {
    const v = relogin();
    assert.throws(() => v.login(USER, 'wrong-password', code()), /Credentials mismatching/);
  });
  check('wrong TOTP → Credentials mismatching', () => {
    const v = relogin();
    const wrong = String((Number(code()) + 1) % 1000000).padStart(6, '0');
    assert.throws(() => v.login(USER, PASS, wrong), /Credentials mismatching/);
  });
  check('correct username (case-insensitive) + passphrase + TOTP unlocks', () => {
    const v = relogin();
    assert.strictEqual(v.login(USER.toUpperCase(), PASS, code()), true);
    assert.strictEqual(v.isUnlocked(), true);
  });
  check('username can be edited while unlocked', () => {
    const v = relogin();
    v.login(USER, PASS, code());
    assert.strictEqual(v.setUsername('New Name'), 'New Name');
    assert.strictEqual(relogin().state.username, 'New Name');
  });
  check('old username stops working after the edit', () => {
    const v = relogin();
    assert.throws(() => v.login(USER, PASS, code()), /Credentials mismatching/);
    assert.strictEqual(v.login('New Name', PASS, code()), true);
  });
  check('editing the username does not change the vault key', () => {
    const v = relogin();
    v.login('New Name', PASS, code());
    const dekA = Buffer.from(v.dek);
    v.lock();
    v.login('New Name', PASS, code());
    assert.deepStrictEqual(Buffer.from(v.dek), dekA);
  });
  check('setUsername is refused while locked', () => {
    const v = relogin();
    assert.throws(() => v.setUsername('Sneaky'), /Unlock/);
  });
  check('legacy profile without a username ignores the field', () => {
    const legacy = path.join(dir, 'legacy.json');
    const v0 = new AuthVault(legacy);
    v0.setup(USER, PASS);
    const legacySecret = Buffer.from(v0._pending.secret);
    v0.confirmSetup(totp(legacySecret));
    const raw = JSON.parse(fs.readFileSync(legacy, 'utf8'));
    delete raw.username;
    fs.writeFileSync(legacy, JSON.stringify(raw));
    const v = new AuthVault(legacy);
    assert.strictEqual(v.login('', PASS, totp(legacySecret)), true);
  });
  check('wipe forgets the profile immediately (no stale login state)', () => {
    const v = relogin();
    v.login('New Name', PASS, code());
    v.wipe();
    assert.strictEqual(v.isConfigured(), false);
    assert.strictEqual(v.isUnlocked(), false);
    assert.strictEqual(fs.existsSync(file), false);
    assert.throws(() => v.login('New Name', PASS, code()), /Not configured/);
  });

  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
