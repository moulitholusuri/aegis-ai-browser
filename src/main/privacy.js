'use strict';
// Privacy manager: automatic cache/session cleaning with user notification,
// manual "clean now", and the app's hardening switches.

const { Notification, app } = require('electron');
const { NetworkGuard } = require('./blocklist');

class PrivacyManager {
  constructor(getSettings, onDataCleaned) {
    this.getSettings = getSettings;
    this.onDataCleaned = onDataCleaned || (() => {});
    this.timer = null;
    this.lastClean = null;
    this.guard = null;
  }

  init() {
    this.guard = new NetworkGuard(this.getSettings, (url, kind) => {
      this.onBlocked && this.onBlocked(url, kind);
    });
    this.startAutoClean();
  }

  setBlockedHandler(fn) { this.onBlocked = fn; }

  // Clear HTTP cache + cookies + site storage across all browsing partitions.
  async clean(what = 'all', reason = 'manual') {
    const targets = ['persist:aegis-browse', 'aegis-private'];
    const results = { cache: 0, cookies: 0, storage: 0, when: Date.now() };
    for (const partition of targets) {
      let ses;
      try { ses = require('electron').session.fromPartition(partition); } catch { continue; }
      try {
        if (what === 'all' || what === 'cache') { await ses.clearCache(); results.cache++; }
        if (what === 'all' || what === 'cookies') {
          // Preserve sign-in cookies for trusted hosts so "work like a normal
          // browser" logins (Google, Microsoft…) survive auto-clean.
          const trusted = (this.getSettings().trustedSites || [])
            .map((h) => String(h).toLowerCase().replace(/^www\./, ''))
            .filter(Boolean);
          const cookies = await ses.cookies.get({});
          let removed = 0;
          for (const c of cookies) {
            const cd = String(c.domain || '').replace(/^\./, '').toLowerCase();
            const keep = trusted.some((h) => cd === h || cd.endsWith(`.${h}`));
            if (keep) { results.preserved = (results.preserved || 0) + 1; continue; }
            const url = `http${c.secure ? 's' : ''}://${c.domain}${c.path || '/'}`;
            await ses.cookies.remove(url, c.name);
            removed++;
          }
          results.cookies += removed;
        }
        if (what === 'all' || what === 'storage') {
          await ses.clearStorageData({
            storages: ['appcache', 'filesystem', 'indexdb', 'localstorage',
              'serviceworkers', 'cachestorage', 'websql', 'shadercache'],
          });
          results.storage++;
        }
      } catch { /* partition may not exist yet */ }
    }
    this.lastClean = results.when;
    const human = `Cache cleared · ${results.cookies} cookies removed`;
    this.onDataCleaned({ ...results, reason, human });
    if (reason !== 'startup') this.notifyUser(human, reason);
    return results;
  }

  notifyUser(body, reason) {
    const title = reason === 'interval' ? 'Aegis auto-cleaned your data' : 'Aegis cleaned your data';
    try {
      if (Notification.isSupported()) {
        new Notification({ title, body, silent: false }).show();
      }
    } catch { /* notifications unavailable */ }
  }

  startAutoClean() {
    this.stopAutoClean();
    const minutes = Number(this.getSettings().autoCleanMinutes ?? 10);
    if (!minutes || minutes <= 0) return; // 0 disables auto-clean
    this.timer = setInterval(() => { this.clean('all', 'interval').catch(() => {}); }, minutes * 60 * 1000);
    this.timer.unref && this.timer.unref();
  }

  stopAutoClean() { if (this.timer) clearInterval(this.timer); this.timer = null; }

  // Called on quit: wipe everything so nothing survives restart.
  async purgeOnQuit() {
    this.stopAutoClean();
    await this.clean('all', 'quit').catch(() => {});
  }

  status() {
    return {
      lastClean: this.lastClean,
      autoCleanMinutes: Number(this.getSettings().autoCleanMinutes ?? 10),
      stats: this.guard ? this.guard.stats() : { total: 0, ads: 0, trackers: 0 },
    };
  }
}

module.exports = { PrivacyManager };
