'use strict';
// Test-only preload for the search-settings UI. Mirrors the shapes main.js
// returns (engines map, normalized custom engines) without booting the app.
const { contextBridge } = require('electron');

const calls = [];
const ok = () => Promise.resolve({ ok: true });
const noop = () => () => {};

const BASE_ENGINES = {
  aegis: { key: 'aegis', label: 'Aegis AI (metasearch)', icon: '🛡️', custom: false, bang: '' },
  google: { key: 'google', label: 'Google', icon: '🔵', custom: false, bang: '' },
  bing: { key: 'bing', label: 'Bing', icon: '🟦', custom: false, bang: '' },
};

let settings = {
  autoCleanMinutes: 10, lockMinutes: 15, blockAds: true, antiFingerprint: true,
  strictReferrer: true, aiBaseUrl: 'https://api.openai.com/v1', aiModel: 'gpt-4o-mini',
  aiMode: 'local',
  searchEngine: 'aegis',
  enabledEngines: ['aegis', 'google', 'bing'],
  customEngines: [],
  searchSources: { web: true, knowledge: true, code: true, papers: true, discussions: true },
  anonymity: 'direct', proxyScheme: 'socks5', proxyHost: '127.0.0.1', proxyPort: 9150,
  strictCookies: true, forceEnglish: true, trustedSites: [],
  engines: null,
};

function buildEngines() {
  const out = JSON.parse(JSON.stringify(BASE_ENGINES));
  for (const ce of settings.customEngines) {
    out[ce.key] = {
      key: ce.key, label: ce.label, icon: '🔎', custom: true, url: ce.url, bang: ce.bang,
    };
  }
  return out;
}
settings.engines = buildEngines();

const snapshot = () => JSON.parse(JSON.stringify(settings));

const setSettings = (patch) => {
  const p = JSON.parse(JSON.stringify(patch || {}));
  calls.push(['settings.set', p]);
  const prevKeys = new Set(settings.customEngines.map((e) => e.key));
  if (p.customEngines) {
    let seq = settings.customEngines.length;
    p.customEngines = p.customEngines
      .filter((e) => e && String(e.label || '').trim() && /%s|\{q\}/.test(String(e.url || '')))
      .slice(0, 20)
      .map((e) => {
        seq += 1;
        return {
          key: e.key || `c${seq}`,
          label: String(e.label).trim(),
          url: String(e.url),
          bang: String(e.bang || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 6),
        };
      });
  }
  Object.assign(settings, p);
  // Mirror main.js: newly added custom engines are auto-enabled.
  const added = settings.customEngines.filter((e) => !prevKeys.has(e.key)).map((e) => e.key);
  if (added.length) {
    settings.enabledEngines = [...new Set([...settings.enabledEngines, ...added])];
  }
  settings.engines = buildEngines();
  settings.enabledEngines = settings.enabledEngines.filter((k) => settings.engines[k]);
  if (!settings.enabledEngines.length) settings.enabledEngines = ['aegis'];
  if (!settings.engines[settings.searchEngine]) settings.searchEngine = 'aegis';
  if (!settings.enabledEngines.includes(settings.searchEngine)) {
    settings.enabledEngines = [...settings.enabledEngines, settings.searchEngine];
  }
  return Promise.resolve({ ok: true, settings: snapshot() });
};

contextBridge.exposeInMainWorld('aegis', {
  auth: {
    status: () => Promise.resolve({ configured: true, unlocked: true, username: 'Test User', hasUsername: true }),
    setup: ok, confirm: ok, login: ok, setUsername: ok, lock: ok, touch: ok, wipe: ok, onLocked: noop,
  },
  tabs: {
    create: ok, close: ok, activate: ok, back: ok, forward: ok, stop: ok, navigate: ok,
    list: () => Promise.resolve([{
      id: 1, title: 'Test page', url: 'https://example.com', favicon: null,
      loading: false, canGoBack: false, canGoForward: false, active: true,
    }]),
    reload: ok, onChanged: noop,
  },
  ai: {
    summarize: ok, ask: ok, autopilot: ok,
    diagnose: () => Promise.resolve({ text: 'No errors recorded.' }),
    onDiagnoseRequest: noop, onDiagEvent: noop, onAutopilotProgress: noop,
    onAskRequest: noop, onSummarizeRequest: noop,
  },
  diag: { report: () => Promise.resolve({ groups: [], total: 0 }), seen: ok },
  ext: {
    list: () => Promise.resolve({ items: [], count: 0 }),
    install: ok, uninstall: ok,
    loadUnpacked: () => Promise.resolve({ ok: false, canceled: true }),
  },
  privacy: {
    clean: ok,
    status: () => Promise.resolve({
      lastClean: Date.now(), autoCleanMinutes: 10,
      stats: { total: 3, ads: 2, trackers: 1 },
    }),
    onCleaned: noop,
  },
  history: { list: () => Promise.resolve({ entries: [] }), delete: ok, clear: ok },
  settings: { get: () => Promise.resolve(snapshot()), set: setSettings, setSecrets: ok },
  net: { status: () => Promise.resolve({ mode: 'direct', rules: '', reachable: null, engine: 'aegis' }) },
  ui: {
    viewport: ok,
    overlay: (name) => { calls.push(['ui.overlay', name]); return ok(); },
    onNotify: noop,
  },
  activity: ok,
});

contextBridge.exposeInMainWorld('__test', {
  calls: () => calls.slice(),
  reset: () => { calls.length = 0; },
});
