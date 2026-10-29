'use strict';
// Test-only preload: a stub of window.aegis so the real renderer + real
// index.html can be booted and driven without the main process.
const { contextBridge } = require('electron');

const calls = [];
const ok = () => Promise.resolve({ ok: true });
const noop = () => () => {};

const items = [
  {
    key: 'night-lens', id: 'night-lens', emoji: '🌙', name: 'Night Lens', version: '1.0.0',
    tagline: 'Dark mode for every site.', category: 'Appearance', rating: 4.7, users: '48.2k',
    external: false, installed: false, loaded: false,
  },
  {
    key: 'cookie-hider', id: 'cookie-hider', emoji: '🍪', name: 'Cookie Banner Hider', version: '1.0.0',
    tagline: 'Hides consent banners without accepting.', category: 'Privacy', rating: 4.9, users: '67.4k',
    external: false, installed: true, loaded: true,
  },
];

const settings = {
  autoCleanMinutes: 10, lockMinutes: 15, blockAds: true, antiFingerprint: true,
  strictReferrer: true, aiBaseUrl: 'https://api.openai.com/v1', aiModel: 'gpt-4o-mini',
  aiMode: 'local',
  engines: {
    aegis: { key: 'aegis', label: 'Aegis AI', icon: '🛡️', custom: false },
    google: { key: 'google', label: 'Google', icon: '🔵', custom: false },
  },
  enabledEngines: ['aegis', 'google'],
  customEngines: [],
  searchSources: { web: true, knowledge: true, code: true, papers: true, discussions: true },
  searchEngine: 'aegis', anonymity: 'direct', proxyScheme: 'socks5',
  proxyHost: '127.0.0.1', proxyPort: 9150, strictCookies: true, forceEnglish: true,
  trustedSites: [],
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
    reload: (id) => { calls.push(['tabs.reload', id]); return ok(); },
    onChanged: noop,
  },
  ai: {
    summarize: ok, ask: ok, autopilot: ok,
    diagnose: () => Promise.resolve({ text: 'No errors recorded.' }),
    onDiagnoseRequest: noop, onDiagEvent: noop, onAutopilotProgress: noop,
    onAskRequest: noop, onSummarizeRequest: noop,
  },
  diag: { report: () => Promise.resolve({ groups: [], total: 0 }), seen: ok },
  ext: {
    list: () => Promise.resolve({ items, count: items.filter((i) => i.loaded).length, bundled: items.length, community: 0 }),
    install: (k) => { calls.push(['ext.install', k]); return ok(); },
    uninstall: (k) => { calls.push(['ext.uninstall', k]); return ok(); },
    loadUnpacked: () => { calls.push(['ext.unpacked']); return Promise.resolve({ ok: false, canceled: true }); },
    refresh: () => { calls.push(['ext.refresh']); return Promise.resolve({ ok: true, count: 0, items: [] }); },
    installUrl: (u) => { calls.push(['ext.installUrl', u]); return ok(); },
    pickFolder: () => { calls.push(['ext.pickFolder']); return Promise.resolve({ ok: false, canceled: true }); },
    publish: (p) => { calls.push(['ext.publish', p && p.dir]); return Promise.resolve({ ok: false, canceled: true }); },
    reveal: (p) => { calls.push(['ext.reveal', p]); return ok(); },
  },
  openExternal: (u) => { calls.push(['openExternal', u]); return ok(); },
  privacy: {
    clean: ok,
    status: () => Promise.resolve({
      lastClean: Date.now(), autoCleanMinutes: 10,
      stats: { total: 3, ads: 2, trackers: 1 },
    }),
    onCleaned: noop,
  },
  history: {
    list: () => Promise.resolve({ entries: [] }),
    delete: ok, clear: ok,
  },
  settings: { get: () => Promise.resolve(settings), set: ok, setSecrets: ok },
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
