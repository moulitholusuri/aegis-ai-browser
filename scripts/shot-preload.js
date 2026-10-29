'use strict';
// Screenshot-only preload: realistic data (all 8 engines + a custom engine +
// sources) so the captured UI looks like a real user's screen.
const { contextBridge } = require('electron');

const noop = () => () => {};
const ok = () => Promise.resolve({ ok: true });
const calls = [];

const BASE_ENGINES = {
  aegis: { key: 'aegis', label: 'Aegis AI (metasearch)', short: 'Aegis AI', icon: '🛡️', custom: false, bang: '' },
  google: { key: 'google', label: 'Google', short: 'Google', icon: '🔵', custom: false, bang: '' },
  bing: { key: 'bing', label: 'Bing', short: 'Bing', icon: '🟦', custom: false, bang: '' },
  ddg: { key: 'ddg', label: 'DuckDuckGo', short: 'DuckDuckGo', icon: '🦆', custom: false, bang: '' },
  startpage: { key: 'startpage', label: 'Startpage', short: 'Startpage', icon: '🕵️', custom: false, bang: '' },
  brave: { key: 'brave', label: 'Brave Search', short: 'Brave Search', icon: '🦁', custom: false, bang: '' },
  youtube: { key: 'youtube', label: 'YouTube', short: 'YouTube', icon: '▶️', custom: false, bang: '' },
  wikipedia: { key: 'wikipedia', label: 'Wikipedia', short: 'Wikipedia', icon: '📚', custom: false, bang: '' },
};

let settings = {
  autoCleanMinutes: 10, lockMinutes: 15, blockAds: true, antiFingerprint: true,
  strictReferrer: true, aiBaseUrl: 'https://api.openai.com/v1', aiModel: 'gpt-4o-mini',
  aiMode: 'local',
  searchEngine: 'aegis',
  enabledEngines: ['aegis', 'google', 'bing', 'ddg', 'startpage', 'brave', 'youtube', 'wikipedia', 'c1'],
  customEngines: [{
    key: 'c1', label: 'Ecosia', url: 'https://www.ecosia.org/search?q=%s', bang: 'eco',
  }],
  searchSources: { web: true, knowledge: true, code: false, papers: true, discussions: true },
  anonymity: 'direct', proxyScheme: 'socks5', proxyHost: '127.0.0.1', proxyPort: 9150,
  strictCookies: true, forceEnglish: true, trustedSites: [],
  engines: null,
};

function buildEngines() {
  const out = JSON.parse(JSON.stringify(BASE_ENGINES));
  for (const ce of settings.customEngines) {
    out[ce.key] = {
      key: ce.key, label: ce.label, short: ce.label, icon: '🔎', custom: true, url: ce.url, bang: ce.bang,
    };
  }
  return out;
}
settings.engines = buildEngines();

const snapshot = () => JSON.parse(JSON.stringify(settings));
const setSettings = (patch) => Promise.resolve({ ok: true, settings: snapshot() });

contextBridge.exposeInMainWorld('aegis', {
  auth: {
    status: () => Promise.resolve({ configured: true, unlocked: true, username: 'Test User', hasUsername: true }),
    setup: ok, confirm: ok, login: ok, setUsername: ok, lock: ok, touch: ok, wipe: ok, onLocked: noop,
  },
  tabs: {
    create: ok, close: ok, activate: ok, back: ok, forward: ok, stop: ok, navigate: ok,
    list: () => Promise.resolve([{
      id: 1, title: 'Aegis AI Browser — private search', url: 'https://example.com', favicon: null,
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
    install: ok, uninstall: ok, loadUnpacked: () => Promise.resolve({ ok: false, canceled: true }),
  },
  privacy: {
    clean: ok,
    status: () => Promise.resolve({
      lastClean: Date.now() - 120000, autoCleanMinutes: 10,
      stats: { total: 148, ads: 96, trackers: 52 },
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
contextBridge.exposeInMainWorld('__test', { calls: () => calls.slice(), reset: () => { calls.length = 0; } });
