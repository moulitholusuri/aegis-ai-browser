'use strict';
// Aegis AI Browser — main process.
// Hardened Electron shell: WebContentsView tabs, TOTP sign-in, encrypted
// history, automated ad/tracker blocking and cache cleaning.

const {
  app, BrowserWindow, WebContentsView, ipcMain, session, Notification, shell, protocol, dialog,
} = require('electron');
const path = require('path');
const fs = require('fs');

const { AuthVault } = require('./auth');
const { EncryptedVault } = require('./vault');
const { PrivacyManager } = require('./privacy');
const { AiEngine, routeIntent } = require('./ai');
const { SearchEngine } = require('./search/engine');
const { makeSearchHandler } = require('./search/protocol');
const {
  chromeUA, stripTrackingParams, buildSearchUrl, testTcp, ENGINES,
  engineMap, DEFAULT_ENABLED_ENGINES, applySearchSettings,
} = require('./anonymity');
const { ErrorModel } = require('./diagnostics');
const { ExtensionStore } = require('./extensions');
const { FaviconCache } = require('./favicon');

// ---------- privileged aegis:// scheme (must be before ready) ----------
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'aegis',
    privileges: {
      standard: true, secure: true, supportFetchAPI: true,
      stream: true, corsEnabled: true,
    },
  },
]);

// ---------- hardened app configuration (before ready) ----------
app.commandLine.appendSwitch('no-sandbox'); // macOS app-style; contents stay sandboxed via webPreferences
app.commandLine.appendSwitch('disable-features', 'InterestFeedContentSuggestions,MediaRouter,OptimizationHints,Translate');
app.commandLine.appendSwitch('disable-background-networking');
app.commandLine.appendSwitch('disable-component-update');
app.commandLine.appendSwitch('disable-sync');
app.commandLine.appendSwitch('no-first-run');
app.commandLine.appendSwitch('disable-breakpad');
app.commandLine.appendSwitch('disable-client-side-phishing-detection');
app.commandLine.appendSwitch('webrtc-ip-handling-policy', 'disable_non_proxied_udp');

// Look like stock Chrome to every site. Electron's default UA embeds
// "Electron/x.y", which Google/Microsoft/banks use to block or profile us.
app.userAgentFallback = chromeUA();

const USER_DIR = app.getPath('userData');
const VAULT_DIR = path.join(USER_DIR, 'vault');
fs.mkdirSync(VAULT_DIR, { recursive: true });

// ---------- ErrorModel: the diagnostic model attached to the AI assistant ----------
// Instrument IPC first so no handler failure is ever silent: every rejection is
// fingerprinted, counted and reported to the assistant ("what errors, how many
// times"). Events stream to the renderer for the 🤖 badge + proactive toasts.
const diagnostics = new ErrorModel(
  path.join(USER_DIR, 'diagnostics.json'),
  (event) => { try { send('diag:event', event); } catch { /* window not ready */ } },
);
diagnostics.instrumentIpc(ipcMain);

// Main-process errors: record, keep running (a browser should not die on one bad
// page or a transient fetch) and surface the issue through the assistant.
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
  diagnostics.record({
    source: 'main', type: 'uncaught',
    message: String((err && err.message) || err), stack: (err && err.stack) || '',
  });
});
process.on('unhandledRejection', (err) => {
  console.error('[unhandledRejection]', err);
  diagnostics.record({
    source: 'main', type: 'unhandled-rejection',
    message: String((err && err.message) || err), stack: (err && err.stack) || '',
  });
});
app.on('render-process-gone', (e, wc, details) => {
  // Chrome-UI renderer; page tabs are instrumented individually via attach().
  diagnostics.record({
    source: 'renderer', type: 'renderer-gone',
    message: String((details && details.reason) || 'unknown'), severity: 'error',
  });
});
app.on('before-quit', () => diagnostics.flush()); // never lose occurrence counts

const auth = new AuthVault(path.join(VAULT_DIR, 'auth.json'));
let vault = null;          // unlocked after sign-in
let privacy = null;
let ai = null;
let win = null;
let idleTimer = null;
let search = null;         // SearchEngine instance

const BROWSE_PARTITION = 'persist:aegis-browse';

// ---------------- favicons ----------------
// Tab favicons are remote images. The chrome UI runs a strict CSP
// (img-src 'self' data:) — and letting the UI fetch them directly would bypass
// the tab partition's proxy/ad-blocker. So fetch the icon inside the tab
// session (same proxy, same blockers) and inline it as a data: URL. Cached per
// URL so re-renders never refetch.
const favicons = new FaviconCache(() => session.fromPartition(BROWSE_PARTITION));

// ---------------- tab management ----------------
const tabs = new Map();    // id -> { id, view, title, url, favicon, loading, canGoBack, canGoForward }
let activeTabId = null;
let nextTabId = 1;
// Overlays (history/settings) render in the chrome DOM, which sits BEHIND the
// native page views — so the active page view is hidden while one is open.
let overlayOpen = null;
let sessionLocked = true; // no page views are shown until sign-in succeeds

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function tabSnapshot(t) {
  return {
    id: t.id, title: t.title, url: t.url, favicon: t.favicon,
    loading: t.loading, canGoBack: t.canGoBack, canGoForward: t.canGoForward,
    active: t.id === activeTabId,
  };
}

function emitTabs() {
  send('tabs:changed', [...tabs.values()].map(tabSnapshot));
}

function createTab(url = 'aegis://newtab', background = false) {
  const id = nextTabId++;
  const view = new WebContentsView({
    webPreferences: {
      partition: BROWSE_PARTITION,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      autoplayPolicy: 'user-gesture-required',
    },
  });
  const wc = view.webContents;
  const tab = {
    id, view, title: 'New Tab', url, favicon: '', loading: false,
    canGoBack: false, canGoForward: false, newTab: url === 'aegis://newtab',
  };
  tabs.set(id, tab);

  privacy.guard.hardenContents(wc);

  wc.on('page-title-updated', (e, title) => { e.preventDefault(); tab.title = title; emitTabs(); });
  wc.on('page-favicon-updated', async (e, faviconsList) => {
    const raw = faviconsList?.[0] || '';
    tab.favicon = raw ? await favicons.dataUrl(raw) : '';
    emitTabs();
  });
  wc.on('did-start-loading', () => { tab.loading = true; emitTabs(); });
  wc.on('did-stop-loading', () => { tab.loading = false; tab.canGoBack = wc.navigationHistory.canGoBack(); tab.canGoForward = wc.navigationHistory.canGoForward(); emitTabs(); });
  wc.on('did-navigate', (e, newUrl) => {
    // A new tab keeps its aegis://newtab identity (the chrome UI renders the
    // hero) even though the blank page underneath is about:blank.
    if (!(newUrl === 'about:blank' && tab.newTab)) {
      tab.url = newUrl;
      tab.newTab = false;
    }
    tab.canGoBack = wc.navigationHistory.canGoBack(); tab.canGoForward = wc.navigationHistory.canGoForward();
    recordHistory(tab);
    syncViewVisibility();
    emitTabs();
  });
  wc.on('did-navigate-in-page', (e, newUrl, isMainFrame) => {
    if (isMainFrame) { tab.url = newUrl; emitTabs(); }
  });
  wc.on('render-process-gone', () => { tab.title = 'Tab crashed — reloading'; wc.reload(); });

  // Open target=_blank / window.open inside the browser as new tabs.
  wc.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) { createTab(url, true); }
    return { action: 'deny' };
  });

  // Kill any navigation to dangerous schemes; strip trackers from link clicks.
  wc.on('will-navigate', (e, newUrl) => {
    if (!/^(https?|aegis):/i.test(newUrl)) {
      e.preventDefault();
      shell.openExternal(newUrl).catch(() => {});
      return;
    }
    const clean = stripTrackingParams(newUrl);
    if (clean !== newUrl) { e.preventDefault(); wc.loadURL(clean).catch(() => {}); }
  });

  diagnostics.attach(wc); // page errors / crashes / load failures → ErrorModel

  wc.loadURL(url === 'aegis://newtab' ? 'about:blank' : url).catch(() => {});
  if (url === 'aegis://newtab') tab.url = 'aegis://newtab';

  if (!background) activateTab(id);
  else { attachBounds(); emitTabs(); }
  return id;
}

function activateTab(id) {
  const tab = tabs.get(id);
  if (!tab) return;
  activeTabId = id;
  if (!win.contentView.children.includes(tab.view)) win.contentView.addChildView(tab.view);
  syncViewVisibility();
  attachBounds();
  emitTabs();
}

// Native page views always paint ABOVE the chrome DOM, so a view is only
// visible when it is the active tab, no chrome overlay/menu is open, and the
// tab isn't the new-tab hero (which lives in the chrome UI).
function syncViewVisibility() {
  for (const t of tabs.values()) {
    const show = !sessionLocked && t.id === activeTabId && !overlayOpen && !t.newTab;
    try { t.view.setVisible(show); } catch { /* ignore */ }
  }
}

function closeTab(id) {
  const tab = tabs.get(id);
  if (!tab) return;
  try { tab.view.webContents.close(); } catch { /* ignore */ }
  win.contentView.removeChildView(tab.view);
  tabs.delete(id);
  if (activeTabId === id) {
    const next = [...tabs.keys()][0];
    if (next) activateTab(next);
    else { activeTabId = null; createTab(); }
  } else emitTabs();
}

let viewport = { x: 0, y: 110, width: 1200, height: 700 };
function attachBounds() {
  const tab = tabs.get(activeTabId);
  if (tab && win) tab.view.setBounds(viewport);
}

// ---------------- history (encrypted at rest) ----------------
function recordHistory(tab) {
  if (!vault || !/^https?:/i.test(tab.url)) return;
  let host = '';
  try { host = new URL(tab.url).hostname; } catch { return; }
  vault.addHistory({ id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, url: tab.url, title: tab.title, ts: Date.now(), host });
}

// ---------------- page text extraction for the AI ----------------
async function extractPage(tabId) {
  const tab = tabs.get(tabId);
  if (!tab) return { title: '', url: '', text: '' };
  const text = await tab.view.webContents.executeJavaScript(`(() => {
    const el = document.body;
    if (!el) return '';
    const clone = el.cloneNode(true);
    clone.querySelectorAll('script,style,noscript,svg,iframe,canvas').forEach(n => n.remove());
    return (clone.innerText || '').replace(/\\n{3,}/g, '\\n\\n').slice(0, 20000);
  })()`, true).catch(() => '');
  return { title: tab.title, url: tab.url, text };
}

// ---------------- auth lifecycle ----------------
function lockSession(reason = 'manual') {
  if (vault && typeof vault.clear === 'function') vault.clear(); // drop decrypted data from memory
  vault = null;
  auth.lock();
  overlayOpen = null;
  sessionLocked = true;
  // Hide page views so no page content shows behind the lock screen.
  for (const t of tabs.values()) { try { t.view.setVisible(false); } catch { /* ignore */ } }
  clearTimeout(idleTimer);
  send('auth:locked', { reason });
}

function startIdleTimer() {
  clearTimeout(idleTimer);
  const minutes = Number(getSettings().lockMinutes ?? 15);
  if (!minutes || minutes <= 0) return;
  idleTimer = setTimeout(() => lockSession('idle'), minutes * 60 * 1000);
  idleTimer.unref && idleTimer.unref();
}

// ---------------- settings ----------------
const SETTINGS_FILE = path.join(VAULT_DIR, 'settings.json');
const DEFAULTS = {
  blockAds: true,
  antiFingerprint: true,
  strictReferrer: true,
  autoCleanMinutes: 10,
  lockMinutes: 15,
  aiBaseUrl: 'https://api.openai.com/v1',
  aiModel: 'gpt-4o-mini',
  searchSources: { web: true, knowledge: true, code: true, papers: true, discussions: true },
  // Normal browsing + anonymity (like Firefox's engine & privacy settings)
  searchEngine: 'aegis',        // see ENGINES in anonymity.js
  enabledEngines: DEFAULT_ENABLED_ENGINES.slice(), // engines shown in the switcher
  customEngines: [],            // user-added: [{ key, label, url, bang }]
  anonymity: 'direct',          // 'direct' | 'tor' | 'custom'
  proxyScheme: 'socks5',        // for 'custom': socks5 | socks4 | http | https
  proxyHost: '127.0.0.1',
  proxyPort: 9150,
  strictCookies: true,          // isolate third-party cookies per top-level site
  forceEnglish: true,           // pin Accept-Language to en-US (fingerprint hygiene)
  trustedSites: [],             // hosts whose sign-in cookies survive auto-clean
};
let settings = { ...DEFAULTS };
try { settings = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) }; } catch { /* first run */ }
function getSettings() { return settings; }
function saveSettings() { fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2)); }
function updateSettings(patch) { settings = { ...settings, ...patch }; saveSettings(); }

// ---------------- extension store ----------------
// Real MV3 extensions loaded into the tab partition (persist:aegis-browse).
const extStore = new ExtensionStore({
  getSession: () => session.fromPartition(BROWSE_PARTITION),
  getSettings,
  setSettings: updateSettings,
});

function notify(title, body) {
  try { if (Notification.isSupported()) new Notification({ title, body }).show(); } catch { /* ignore */ }
  send('notify', { title, body });
}

// ---------------- anonymity network (IP hiding) ----------------
function currentProxyRules() {
  const mode = settings.anonymity || 'direct';
  if (mode === 'tor') return 'socks5://127.0.0.1:9150';
  if (mode === 'custom' && settings.proxyHost && settings.proxyPort) {
    const scheme = ['socks4', 'socks5', 'http', 'https'].includes(settings.proxyScheme) ? settings.proxyScheme : 'socks5';
    return `${scheme}://${settings.proxyHost}:${settings.proxyPort}`;
  }
  return ''; // direct
}

// Apply the proxy to every browsing session. Called at startup and whenever
// the anonymity settings change; drops live connections so it takes effect
// immediately without a restart.
function applyAnonymity() {
  const proxyRules = currentProxyRules();
  for (const partition of [BROWSE_PARTITION, 'aegis-private']) {
    try {
      const ses = session.fromPartition(partition);
      ses.setProxy({ proxyRules }).then(() => ses.closeAllConnections()).catch(() => {});
    } catch { /* partition not created yet */ }
  }
}

// ---------------- IPC ----------------
ipcMain.handle('auth:status', () => ({
  configured: auth.isConfigured(),
  unlocked: auth.isUnlocked(),
}));

ipcMain.handle('auth:setup', async (e, { passphrase }) => {
  const { qr, secret } = await auth.setup(passphrase);
  return { qr, secret };
});

ipcMain.handle('auth:confirm', (e, { code }) => {
  auth.confirmSetup(code);
  vault = new EncryptedVault(auth.dek, path.join(VAULT_DIR, 'vault.enc'));
  sessionLocked = false;
  startIdleTimer();
  return { ok: true };
});

ipcMain.handle('auth:login', (e, { passphrase, code }) => {
  auth.login(passphrase, code);
  vault = new EncryptedVault(auth.dek, path.join(VAULT_DIR, 'vault.enc'));
  sessionLocked = false;
  syncViewVisibility();
  startIdleTimer();
  return { ok: true };
});

ipcMain.handle('auth:lock', () => { lockSession('manual'); return { ok: true }; });
ipcMain.handle('auth:touch', () => { if (vault) startIdleTimer(); return { ok: true }; });
ipcMain.handle('auth:wipe', () => {
  vault && vault.wipeFile && vault.wipeFile();
  auth.wipe();
  for (const t of tabs.values()) { try { t.view.webContents.close(); } catch {} }
  tabs.clear(); activeTabId = null;
  privacy.clean('all', 'wipe').catch(() => {});
  notify('Aegis', 'All local data wiped.');
  return { ok: true };
});

ipcMain.handle('tabs:create', (e, { url, background } = {}) => createTab(url || 'aegis://newtab', !!background));
ipcMain.handle('tabs:close', (e, { id }) => closeTab(id));
ipcMain.handle('tabs:activate', (e, { id }) => activateTab(id));
ipcMain.handle('tabs:list', () => [...tabs.values()].map(tabSnapshot));
ipcMain.handle('tabs:back', (e, { id }) => { tabs.get(id)?.view.webContents.navigationHistory.goBack(); });
ipcMain.handle('tabs:forward', (e, { id }) => { tabs.get(id)?.view.webContents.navigationHistory.goForward(); });
ipcMain.handle('tabs:reload', (e, { id }) => { tabs.get(id)?.view.webContents.reload(); });
ipcMain.handle('tabs:stop', (e, { id }) => { tabs.get(id)?.view.webContents.stop(); });

// Smart navigation: URL vs search vs AI question, decided by the intent router.
ipcMain.handle('tabs:navigate', (e, { id, input }) => {
  const tab = tabs.get(id);
  if (!tab) return { ok: false };
  const intent = routeIntent(input);
  const wc = tab.view.webContents;
  if (intent.type === 'navigate') {
    // Strip tracking params from every link the user opens.
    wc.loadURL(stripTrackingParams(intent.url)).catch(() => {});
  } else if (intent.type === 'search' || intent.type === 'compare') {
    // Normal-browser behavior: search goes to the user's chosen engine
    // (Google, Bing, DuckDuckGo, Startpage, Brave, or Aegis metasearch).
    // Bangs (!g, !b, !ddg, !yt, !w, !a…) override the default per query.
    const raw = intent.type === 'compare' ? `${intent.query} comparison` : intent.query;
    wc.loadURL(buildSearchUrl(settings.searchEngine, raw, settings)).catch(() => {});
  }
  else if (intent.type === 'ask') { send('ai:ask-request', { tabId: id, question: intent.question }); }
  else if (intent.type === 'summarize') { send('ai:summarize-request', { tabId: id }); }
  else if (intent.type === 'diagnose') { send('ai:diagnose-request', { tabId: id }); }
  return { ok: true, intent: intent.type };
});

ipcMain.handle('ui:viewport', (e, rect) => { viewport = rect; attachBounds(); return { ok: true }; });

// Chrome overlays (history/settings) are DOM panels that sit behind the native
// page views — hide the active view while one is open so it's actually visible.
// (History now uses a sidebar and doesn't need this; settings modal does.)
ipcMain.handle('ui:overlay', (e, name) => {
  try {
    overlayOpen = name || null;
    syncViewVisibility(); // native views would otherwise cover the menu/modal
    return { ok: true, open: overlayOpen };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
});

// ---------------- AI ----------------
ipcMain.handle('ai:summarize', async (e, { tabId }) => {
  const page = await extractPage(tabId ?? activeTabId);
  return ai.summarize(page);
});
ipcMain.handle('ai:ask', async (e, { tabId, question }) => {
  const page = await extractPage(tabId ?? activeTabId);
  return ai.ask(question, page);
});

// ---------------- diagnostics (ErrorModel ↔ assistant) ----------------
ipcMain.handle('diag:report', () => diagnostics.report());
ipcMain.handle('diag:seen', () => { diagnostics.markSeen(); return { ok: true }; });

// The assistant's health briefing: structured report + spoken text. In cloud
// mode the LLM narrates it (keeping the ×counts); local mode uses the model's
// own plain-language explanations and per-error advice.
ipcMain.handle('ai:diagnose', async () => {
  const report = diagnostics.report({ sinceMs: 24 * 60 * 60 * 1000 });
  const local = diagnostics.formatReport(report);
  const cloud = await ai.chat(
    'You are the Aegis browser assistant giving an application health briefing. ' +
    'You receive a JSON report of errors the app collected. Reply with a friendly ' +
    'briefing of at most 8 short lines: what is failing, how often each thing occurs ' +
    '(keep the ×N counts exactly), and one concrete fix per recurring issue. ' +
    'If the report is empty, reply with one line confirming everything is healthy. No preamble.',
    JSON.stringify(report).slice(0, 6000),
    { maxTokens: 450 },
  ).catch(() => null);
  diagnostics.markSeen();
  return { mode: cloud ? 'cloud' : 'local', report, text: cloud || local };
});

// Autopilot: run a multi-step plan against the active tab.
ipcMain.handle('ai:autopilot', async (e, { task }) => {
  const page = await extractPage(activeTabId);
  const { mode, steps } = await ai.planTask(task, page);
  const log = [];
  for (const step of steps) {
    const wc = tabs.get(activeTabId)?.view.webContents;
    if (!wc) break;
    if (step.action === 'navigate' && /^https?:/i.test(step.url || '')) {
      log.push(`→ Opening ${step.url}`);
      send('ai:autopilot-progress', { log });
      await wc.loadURL(step.url).catch(() => {});
    } else if (step.action === 'search' && step.query) {
      const u = `aegis://search?q=${encodeURIComponent(step.query)}`;
      log.push(`→ Searching for “${step.query}”`);
      send('ai:autopilot-progress', { log });
      await wc.loadURL(u).catch(() => {});
    } else if (step.action === 'summarize') {
      log.push('→ Summarizing page');
      send('ai:autopilot-progress', { log });
      const p = await extractPage(activeTabId);
      const r = await ai.summarize(p);
      log.push(r.summary);
      send('ai:autopilot-progress', { log });
    } else if (step.action === 'ask' && step.question) {
      log.push(`→ Asking: ${step.question}`);
      send('ai:autopilot-progress', { log });
      const p = await extractPage(activeTabId);
      const r = await ai.ask(step.question, p);
      log.push(r.answer);
      send('ai:autopilot-progress', { log });
    } else if (step.action === 'done') {
      log.push(`✓ Done: ${step.reason || 'task complete'}`);
      send('ai:autopilot-progress', { log });
      break;
    }
  }
  return { mode, log };
});

// ---------------- privacy ----------------
ipcMain.handle('privacy:clean', async (e, { what } = {}) => privacy.clean(what || 'all', 'manual'));
ipcMain.handle('privacy:status', () => privacy.status());

// ---------------- history / secrets (require unlock) ----------------
ipcMain.handle('history:list', (e, { query, limit } = {}) => {
  if (!vault) return { error: 'locked' };
  return { entries: vault.listHistory(query, limit) };
});
ipcMain.handle('history:delete', (e, { id }) => { if (vault) vault.deleteHistory(id); return { ok: true }; });
ipcMain.handle('history:clear', () => { if (vault) vault.clearHistory(); return { ok: true }; });

// Engine list is sent as plain {key: label} data — functions can't cross IPC
// (structured clone), and sending them crashed this handler entirely.
ipcMain.handle('settings:get', () => ({
  ...settings,
  engines: engineMap(settings),
  aiMode: ai.mode(),
  hasAiKey: !!(vault && vault.getSecrets().aiApiKey),
}));
ipcMain.handle('settings:set', (e, patch) => {
  const wasCleanMinutes = settings.autoCleanMinutes;
  // Never accept an API key through plain settings — it goes via secrets:set.
  const { aiApiKey, ...safe } = patch || {};

  // Search customization (engines, sources, defaults) is validated in one pure
  // helper — a bad value can never leave the omnibox pointing at a broken URL.
  if (Array.isArray(safe.trustedSites)) {
    safe.trustedSites = safe.trustedSites
      .map((s) => String(s).trim().toLowerCase().replace(/^www\./, '').replace(/\/.*$/, ''))
      .filter((s) => /^[\w.-]+\.[a-z]{2,}$/.test(s))
      .slice(0, 50);
  }
  settings = applySearchSettings(settings, safe);

  saveSettings();
  if (patch.autoCleanMinutes !== undefined && patch.autoCleanMinutes !== wasCleanMinutes) privacy.startAutoClean();
  // Anonymity network changes take effect immediately.
  if ('anonymity' in safe || 'proxyScheme' in safe || 'proxyHost' in safe || 'proxyPort' in safe) applyAnonymity();
  return { ok: true, settings };
});

// Live network status: which anonymity route is active, and is it reachable.
ipcMain.handle('net:status', async () => {
  const mode = settings.anonymity || 'direct';
  const rules = currentProxyRules();
  let reachable = null;
  if (mode === 'tor') reachable = await testTcp('127.0.0.1', 9150);
  else if (mode === 'custom' && settings.proxyHost && settings.proxyPort) {
    reachable = await testTcp(settings.proxyHost, settings.proxyPort);
  }
  return { mode, rules, reachable, engine: settings.searchEngine || 'aegis' };
});
ipcMain.handle('secrets:set', (e, { aiApiKey, aiBaseUrl, aiModel }) => {
  if (!vault) return { error: 'locked' };
  vault.setSecrets({ aiApiKey, ...(aiBaseUrl ? { aiBaseUrl } : {}), ...(aiModel ? { aiModel } : {}) });
  return { ok: true };
});

// ---------------- extension store ----------------
ipcMain.handle('ext:list', () => extStore.list());
ipcMain.handle('ext:install', (e, key) => extStore.install(String(key)));
ipcMain.handle('ext:uninstall', (e, key) => extStore.uninstall(String(key)));
ipcMain.handle('ext:unpacked', async () => {
  const opts = {
    title: 'Load unpacked extension',
    properties: ['openDirectory'],
    message: 'Choose a folder containing manifest.json',
  };
  const r = win && !win.isDestroyed()
    ? await dialog.showOpenDialog(win, opts)
    : await dialog.showOpenDialog(opts);
  if (r.canceled || !r.filePaths[0]) return { ok: false, canceled: true };
  try {
    return await extStore.loadUnpacked(r.filePaths[0]);
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});

// ---------------- window ----------------
function createWindow() {
  win = new BrowserWindow({
    width: 1280, height: 840, minWidth: 900, minHeight: 600,
    title: 'Aegis AI Browser',
    backgroundColor: '#0b0f14',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 18, y: 16 },
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
      spellcheck: false,
    },
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  // Renderer is UI-only; it never loads remote content.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file://')) e.preventDefault();
  });
  diagnostics.attach(win.webContents); // chrome-UI console errors → ErrorModel

  win.on('closed', () => { win = null; });
}

app.whenReady().then(() => {
  // Deny every permission request at the app level too (belt & braces).
  app.on('web-contents-created', (e, contents) => {
    contents.setPermissionRequestHandler?.((wc, permission, cb) => {
      cb(['fullscreen', 'pointerLock'].includes(permission));
    });
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  });

  privacy = new PrivacyManager(getSettings, (info) => {
    send('privacy:cleaned', info);
  });
  privacy.setBlockedHandler(() => {});
  privacy.init();
  privacy.guard.attach(BROWSE_PARTITION);
  privacy.guard.attach('aegis-private');
  applyAnonymity(); // route through Tor/proxy if configured

  // Re-load installed extensions (Electron forgets them across restarts).
  extStore.loadInstalled().catch((err) => {
    console.warn('[ext] startup load failed:', err.message);
  });

  ai = new AiEngine(getSettings, () => (vault ? vault.getSecrets() : {}));

  // First-party AI search engine: metasearch + ranking + answer synthesis.
  search = new SearchEngine({ getSettings, ai });

  // Feed per-source search failures into the ErrorModel, so the assistant can
  // report "Wikipedia timed out ×4" instead of silently skipping the source.
  {
    const rawSearch = search.search.bind(search);
    search.search = (q, onProgress) => rawSearch(q, (ev) => {
      try {
        if (ev && ev.type === 'source' && ev.error) {
          diagnostics.record({
            source: 'search',
            type: `search-source:${ev.source}`,
            message: `${ev.label || ev.source}: ${ev.error}`,
            severity: 'warn',
          });
        }
      } catch { /* recording must never break search */ }
      return typeof onProgress === 'function' ? onProgress(ev) : undefined;
    });
  }

  // aegis:// scheme: register the handler on BOTH the default session and the
  // session that serves page tabs. Page tabs live in the persist:aegis-browse
  // partition, which has its own protocol registry — registering only on the
  // default session leaves aegis:// URLs unhandled inside tabs (the bug that
  // broke omnibox search). Standard-scheme routing is host-based:
  //   aegis://search?q=x        -> host "search", path "/"
  //   aegis://search/api/search -> host "search", path "/api/search"
  const handler = makeSearchHandler(search);
  protocol.handle('aegis', handler);
  try {
    session.fromPartition(BROWSE_PARTITION).protocol.handle('aegis', handler);
    session.fromPartition('aegis-private').protocol.handle('aegis', handler);
  } catch (err) {
    console.error('aegis:// session protocol registration failed:', err);
  }

  createWindow();

  // Warn on certificate errors instead of silently failing.
  app.on('certificate-error', (event, wc, url, error) => {
    event.preventDefault();
    notify('Security warning', `Invalid certificate blocked for ${url} (${error})`);
  });
});

app.on('window-all-closed', () => app.quit());

app.on('before-quit', (e) => {
  // Best-effort purge of session data on quit.
  e.preventDefault();
  (async () => {
    try { await privacy.purgeOnQuit(); } catch { /* ignore */ }
    app.exit(0);
  })();
});
