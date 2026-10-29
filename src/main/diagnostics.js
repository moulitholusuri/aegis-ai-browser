'use strict';
// ============================================================================
// ErrorModel — the application's diagnostic model, attached to the AI assistant.
// ============================================================================
// Collects every error from every layer of Aegis (main process, IPC bridge,
// page renderers, network loads, search sources, sign-in), fingerprints them
// so identical errors group together, counts occurrences, keeps first/last
// timestamps, and explains each group in plain language with a suggested fix.
//
// The AI assistant uses it to:
//   - proactively announce NEW errors ("⚠️ Browser bridge error ×1 — logged")
//   - answer "what errors are you facing, and how many times?" via the
//     health report (🩺 button / "diagnose" typed in the omnibox)
//
// Privacy: URLs are reduced to hostnames, numbers/UUIDs are normalized away,
// so the on-disk report contains no page contents or query strings.
// Retention: 7 days, max 300 distinct groups, saved debounced to disk.

const fs = require('fs');
const path = require('path');

const RETENTION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const MAX_GROUPS = 300;
const MAX_EVENTS_PER_RECORD = 1; // (reserved for batching)

// ---------- fingerprinting: identical errors must land in one group ----------
function fingerprint(type, message) {
  const norm = String(message || '')
    .replace(/https?:\/\/[^\s)"'>]+/g, (m) => { try { return new URL(m).hostname || '<url>'; } catch { return '<url>'; } })
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<uuid>')
    .replace(/\b\d+(\.\d+)?\b/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
  return `${type}|${norm}`;
}

// ---------- knowledge base: explain errors the way a good engineer would ----------
const NET_ERRORS = {
  '-105': ['Name not resolved (DNS)', 'The domain could not be found. Check the spelling, or DNS/proxy may be down — if a Tor/proxy is set in Settings, run "Test connection".'],
  '-102': ['Connection refused', 'The server actively refused the connection — the site may be down, or blocking this network.'],
  '-101': ['Connection reset', 'The connection dropped mid-transfer — usually the server or an intermediary reset it. Retry.'],
  '-7': ['Connection timed out', 'No response in time. Check your anonymity network (Tor/proxy) settings and Test connection.'],
  '-118': ['Load timed out', 'The page took too long to load — a slow source or an overloaded proxy/Tor circuit.'],
  '-106': ['No internet connection', 'The machine appears to be offline. Check Wi-Fi/Ethernet.'],
  '-137': ['Name resolution failed', 'System DNS could not resolve the host — network issue or a mis-typed address.'],
  '-21': ['Network changed', 'The network switched mid-load (Wi-Fi/VPN change). Harmless — reload the tab.'],
  '-3': ['Navigation aborted', 'The load was cancelled because you navigated elsewhere. Harmless.'],
  '-1011': ['Blocked by content settings', 'Aegis blocked part of this request (tracker/ad protection). Expected.'],
  '-27': ['Not a trusted certificate', 'TLS verification failed — do NOT ignore this; the connection may be intercepted.'],
};

const TYPE_EXPLAINERS = [
  // [matcher, fn(type, message) -> { title, advice }]
  [/^net:(-?\d+)$/, (t) => {
    const code = t.match(/^net:(-?\d+)$/)[1];
    const known = NET_ERRORS[code];
    if (known) return { title: `Network error — ${known[0]}`, advice: known[1] };
    return { title: `Network error ${code}`, advice: 'The page could not be loaded. Retry, or check network/proxy settings.' };
  }],
  // Sign-in (must match BEFORE the generic ipc: rule — types look like ipc:auth:login)
  [/^(?:ipc:)?auth/, () => ({
    title: 'Sign-in issue',
    advice: 'A sign-in attempt failed. Check your passphrase, and make sure you use the CURRENT Google Authenticator code (codes rotate every 30 s).',
  })],
  [/^ipc:/, (t) => ({
    title: 'Browser bridge (IPC) error',
    advice: `The UI asked the browser core to run "${t.slice(4)}" and it threw. This is a genuine app bug — restart Aegis and report the count below to the developer.`,
  })],
  [/^search-source:/, () => ({
    title: 'Search source failed',
    advice: 'An upstream source (DuckDuckGo, Wikipedia, …) did not answer — usually timeout, rate-limit or captcha. The other sources still answer; Aegis skips it automatically.',
  })],
  [/^renderer-gone/, () => ({
    title: 'Page process crashed',
    advice: 'A renderer (tab or chrome UI) died — often memory pressure or a GPU hiccup. Aegis reloads it automatically; repeated crashes suggest a heavy page.',
  })],
  [/^unresponsive/, () => ({
    title: 'Page stopped responding',
    advice: 'A tab hung for a moment. If it repeats, close background tabs — the page itself may be stuck in a script loop.',
  })],
  [/^console/, () => ({
    title: 'Script error on a page',
    advice: "The website's own JavaScript threw an error — not Aegis' fault unless it repeats on every page you open.",
  })],
  [/^uncaught/, () => ({
    title: 'Main-process bug (uncaught exception)',
    advice: 'The browser core hit an unexpected condition. Aegis keeps running and logged the stack — report it with the count below.',
  })],
  [/^unhandled-rejection/, () => ({
    title: 'Async operation failed silently',
    advice: 'A background operation rejected without a handler (e.g. a failed fetch). Often network-related; the count shows how often it recurs.',
  })],
  [/^protocol/, () => ({
    title: 'aegis:// internal page error',
    advice: 'An internal page (search/newtab) failed to serve. Restart Aegis if search pages stop loading.',
  })],
];

function explain(type, message) {
  for (const [re, fn] of TYPE_EXPLAINERS) {
    if (re.test(type)) {
      try { return fn(type, message); } catch { break; }
    }
  }
  return {
    title: String(type || 'Error').replace(/[-_]/g, ' '),
    advice: 'No specific playbook for this one yet — see occurrences below.',
  };
}

// ============================================================================
class ErrorModel {
  /**
   * @param {string} file  where the report is persisted
   * @param {(event) => void} onEvent  called on every recorded error
   *        event = { key, isNew, count, severity, source, title, advice, message, unread }
   */
  constructor(file, onEvent) {
    this.file = file;
    this.onEvent = onEvent || (() => {});
    this.groups = new Map();
    this.unread = 0;         // distinct issues not yet shown in the assistant
    this._saveTimer = null;
    this._pruneCounter = 0;
    this.load();
  }

  // ---------------- persistence ----------------
  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      for (const g of raw.groups || []) if (g && g.key) this.groups.set(g.key, g);
    } catch { /* first run or corrupt file — start fresh */ }
    this.prune();
    // Issues recorded before this launch still count as unseen.
    this.unread = [...this.groups.values()].filter((g) => g.unread !== false).length;
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify({ v: 1, groups: [...this.groups.values()] }));
    } catch { /* disk full / permission — diagnostics must never break the app */ }
  }

  scheduleSave() {
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => { this._saveTimer = null; this.save(); }, 1000);
    if (this._saveTimer.unref) this._saveTimer.unref();
  }

  // Write immediately (called on quit so no occurrence counts are lost).
  flush() {
    if (this._saveTimer) { clearTimeout(this._saveTimer); this._saveTimer = null; }
    this.save();
  }

  prune() {
    const cutoff = Date.now() - RETENTION_MS;
    for (const [k, g] of this.groups) if (g.lastSeen < cutoff) this.groups.delete(k);
    if (this.groups.size > MAX_GROUPS) {
      const sorted = [...this.groups.values()].sort((a, b) => b.lastSeen - a.lastSeen);
      for (const g of sorted.slice(MAX_GROUPS)) this.groups.delete(g.key);
    }
  }

  // ---------------- recording ----------------
  record({ source = 'app', type = 'error', message = '', detail = '', severity = 'error', stack = '' }) {
    try {
      const now = Date.now();
      const key = fingerprint(type, message);
      let g = this.groups.get(key);
      const isNew = !g;
      if (!g) {
        g = {
          key, source, type,
          message: String(message || '').slice(0, 300),
          detail: String(detail || '').slice(0, 200),
          severity, count: 0,
          firstSeen: now, lastSeen: now,
          unread: true,
          stack: stack ? String(stack).slice(0, 800) : '',
        };
        this.groups.set(key, g);
        this.unread++;
      }
      g.count++;
      g.lastSeen = now;
      if (severity === 'error') g.severity = 'error'; // never downgrade
      if (!g.stack && stack) g.stack = String(stack).slice(0, 800);

      if (++this._pruneCounter % 50 === 0) this.prune();
      this.scheduleSave();

      const ex = explain(g.type, g.message);
      const event = {
        key: g.key, isNew, count: g.count, severity: g.severity,
        source: g.source, title: ex.title, advice: ex.advice,
        message: g.message, unread: this.unread,
      };
      try { this.onEvent(event); } catch { /* renderer gone — ignore */ }
      return g;
    } catch { return null; } // recording must NEVER throw into callers
  }

  markSeen() {
    this.unread = 0;
    for (const g of this.groups.values()) g.unread = false;
    this.scheduleSave();
  }

  // ---------------- reporting ----------------
  report({ sinceMs = 0, limit = 20 } = {}) {
    const cutoff = sinceMs ? Date.now() - sinceMs : 0;
    const all = [...this.groups.values()].filter((g) => !cutoff || g.lastSeen >= cutoff);
    const bySource = {};
    let events = 0;
    for (const g of all) {
      bySource[g.source] = (bySource[g.source] || 0) + g.count;
      events += g.count;
    }
    const top = all
      .sort((a, b) => b.count - a.count || b.lastSeen - a.lastSeen)
      .slice(0, limit)
      .map((g) => {
        const ex = explain(g.type, g.message);
        return {
          type: g.type, source: g.source, severity: g.severity,
          count: g.count, message: g.message, detail: g.detail,
          firstSeen: g.firstSeen, lastSeen: g.lastSeen,
          title: ex.title, advice: ex.advice,
        };
      });
    return {
      generatedAt: Date.now(),
      groups: all.length,
      events,
      unread: this.unread,
      bySource,
      top,
    };
  }

  // Plain-text briefing used by the assistant when no cloud model is configured.
  formatReport(report) {
    const when = new Date(report.generatedAt).toLocaleTimeString();
    if (!report.groups) {
      return `🩺 App health report (${when})\n\n✅ No errors recorded. The application is healthy.`;
    }
    const lines = report.top.slice(0, 8).map((g, i) => {
      const last = new Date(g.lastSeen).toLocaleTimeString();
      return `${i + 1}. [×${g.count} · last ${last}] ${g.title}\n   ${String(g.message).slice(0, 140)}\n   → ${g.advice}`;
    });
    const unread = report.unread ? ` · ${report.unread} new since your last report` : '';
    return `🩺 App health report (${when})\n\n${report.groups} distinct issue(s) · ${report.events} occurrence(s)${unread}\n\n${lines.join('\n\n')}`;
  }

  // ---------------- instrumentation ----------------
  // Wrap ipcMain.handle so NO handler error is ever silent again — every
  // rejection is recorded (channel, message, stack, occurrence count) and
  // still re-throws so callers see the original failure.
  instrumentIpc(ipcMainRef) {
    const original = ipcMainRef.handle.bind(ipcMainRef);
    ipcMainRef.handle = (channel, listener) => original(channel, async (event, ...args) => {
      try {
        return await listener(event, ...args);
      } catch (err) {
        const msg = String((err && err.message) || err);
        // Wrong passphrase / expired TOTP code = user-input issue, not a bug:
        // counted and reportable, but doesn't deserve a red "app error" toast.
        const userInput = /^auth:/.test(channel) && /wrong|invalid|expired|incorrect/i.test(msg);
        this.record({
          source: 'ipc',
          type: `ipc:${channel}`,
          message: msg,
          stack: (err && err.stack) || '',
          severity: userInput ? 'warn' : 'error',
        });
        throw err;
      }
    });
    return this;
  }

  // Passive listeners on any webContents (tabs + chrome UI):
  // page script errors, renderer crashes, load failures, hangs.
  attach(wc) {
    if (!wc || typeof wc.on !== 'function') return this;
    try {
      // Electron ≥30 passes an event object; older passes (level, message, …).
      wc.on('console-message', (...args) => {
        try {
          const ev = args[0];
          const level = (ev && typeof ev.level === 'number') ? ev.level : args[1];
          const message = (ev && typeof ev.message === 'string') ? ev.message : args[2];
          const sourceId = (ev && typeof ev.sourceId === 'string') ? ev.sourceId : args[4];
          if (!message || typeof level !== 'number' || level < 2) return;
          let host = '';
          try { host = sourceId ? new URL(sourceId).hostname : ''; } catch { /* data: etc */ }
          this.record({
            source: 'page',
            type: 'console',
            message,
            detail: host,
            // Graceful under both level numbering schemes (0/1/2 vs 0..3):
            // page script noise is never an app *error*, but is counted.
            severity: 'warn',
          });
        } catch { /* never break the page */ }
      });
      wc.on('render-process-gone', (e, details) => {
        this.record({
          source: 'renderer',
          type: 'renderer-gone',
          message: String((details && details.reason) || 'unknown'),
          detail: String((details && details.exitCode) || ''),
          severity: 'error',
        });
      });
      wc.on('did-fail-load', (e, code, desc, url, isMainFrame) => {
        if (!isMainFrame || code === -3) return; // -3 = aborted by navigation: harmless
        let host = '';
        try { host = url ? new URL(url).hostname : ''; } catch { /* ignore */ }
        this.record({
          source: 'network',
          type: `net:${code}`,
          message: `${desc || 'load failed'} — ${host || 'unknown host'}`,
          detail: String(code),
          severity: 'warn',
        });
      });
      wc.on('unresponsive', () => {
        this.record({ source: 'renderer', type: 'unresponsive', message: 'page stopped responding', severity: 'warn' });
      });
    } catch { /* attach is best-effort */ }
    return this;
  }
}

module.exports = { ErrorModel, fingerprint, explain };
