'use strict';
// EncryptedVault: AES-256-GCM encrypted at-rest store for browsing history and
// secrets (e.g. the AI provider API key). Plaintext never touches the disk.

const fs = require('fs');
const path = require('path');
const { encrypt, decrypt } = require('./crypto-utils');

const MAX_HISTORY = 2000;

class EncryptedVault {
  constructor(dek, file) {
    this.dek = dek;
    this.file = file;
    this.data = { history: [], secrets: {} };
    this.load();
  }

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.data = JSON.parse(decrypt(this.dek, raw).toString('utf8'));
      if (!Array.isArray(this.data.history)) this.data.history = [];
      if (!this.data.secrets || typeof this.data.secrets !== 'object') this.data.secrets = {};
    } catch {
      this.data = { history: [], secrets: {} };
    }
  }

  persist() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const blob = encrypt(this.dek, Buffer.from(JSON.stringify(this.data), 'utf8'));
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(blob), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  addHistory(entry) {
    // entry: { id, url, title, ts, host }
    this.data.history.unshift(entry);
    if (this.data.history.length > MAX_HISTORY) this.data.history.length = MAX_HISTORY;
    this.persist();
  }

  listHistory(query, limit = 200) {
    const q = String(query || '').trim().toLowerCase();
    let items = this.data.history;
    if (q) items = items.filter((e) => (e.url || '').toLowerCase().includes(q) || (e.title || '').toLowerCase().includes(q));
    return items.slice(0, limit).map(({ id, url, title, ts, host }) => ({ id, url, title, ts, host }));
  }

  deleteHistory(id) {
    const before = this.data.history.length;
    this.data.history = this.data.history.filter((e) => e.id !== id);
    if (this.data.history.length !== before) this.persist();
  }

  clearHistory() {
    this.data.history = [];
    this.persist();
  }

  getSecrets() { return { ...this.data.secrets }; }

  // Drop decrypted data from memory (called on lock). File stays encrypted.
  clear() {
    this.data = { history: [], secrets: {} };
  }

  setSecrets(patch) {
    this.data.secrets = { ...this.data.secrets, ...patch };
    this.persist();
  }

  wipeFile() {
    this.data = { history: [], secrets: {} };
    try { fs.rmSync(this.file, { force: true }); } catch { /* ignore */ }
  }
}

module.exports = { EncryptedVault };
