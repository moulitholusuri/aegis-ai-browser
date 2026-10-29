'use strict';
// Live community-store test: fetches the REAL GitHub-hosted catalog, installs
// the published .zip over HTTPS, verifies its SHA-256, and proves the content
// script actually runs in a real tab. Then uninstalls it.
//
// Run with: npx electron scripts/test-store-remote.js
// Requires network access (GitHub raw + release assets).

const { app, session, BrowserWindow } = require('electron');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ExtensionStore } = require('../src/main/extensions');

const PROFILE = path.join(os.tmpdir(), 'aegis-store-remote-' + Date.now());
app.setPath('userData', PROFILE);
app.commandLine.appendSwitch('no-sandbox');

const PARTITION = 'persist:aegis-remote-test';
const SPEC_ENTRY = 'reading-time';

let pass = 0, fail = 0;
const check = (name, cond, extra) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}${extra ? ` — ${extra}` : ''}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ~600 words of article text so Reading Time definitely renders its badge.
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>remote ext test</title></head>
<body><article>${('Aegis keeps browsing private and fast. '.repeat(60))}</article></body></html>`;

app.whenReady().then(async () => {
  try {
    const ses = session.fromPartition(PARTITION);
    const settings = {};
    const store = new ExtensionStore({
      getSession: () => ses,
      getSettings: () => settings,
      setSettings: (patch) => Object.assign(settings, patch),
      getStoreDir: () => path.join(PROFILE, 'extensions'),
    });

    // ---- 1. live catalog -------------------------------------------------
    console.log('— fetching https://raw.githubusercontent.com/.../store/index.json —');
    const cat = await store.refresh();
    check('live community catalog fetched', !!(cat && cat.ok), cat && cat.error);
    check('catalog lists at least one extension', (cat && cat.count || 0) >= 1, `count=${cat && cat.count}`);

    const entry = store.remoteEntries().find((e) => e.id === SPEC_ENTRY);
    check(`catalog contains "${SPEC_ENTRY}"`, !!entry);
    if (!entry) throw new Error('published extension missing from the live catalog');
    check('entry has an HTTPS download URL', /^https:\/\//.test(entry.downloadUrl), entry.downloadUrl);
    check('entry is pinned to a SHA-256', /^[a-f0-9]{64}$/.test(entry.sha256), entry.sha256);

    // ---- 2. HTTPS download + hash verify + install ----------------------
    console.log(`— downloading ${entry.downloadUrl} —`);
    const installed = await store.installFromUrl(entry.downloadUrl, entry.sha256, entry.id);
    check('package downloaded, hash-verified and loaded', !!(installed && installed.ok && installed.verified));
    check('installed manifest exists on disk',
      fs.existsSync(path.join(store.remoteDir(entry.id), 'manifest.json')));
    check('install persisted to settings',
      (settings.externalExtensions || []).includes(store.remoteDir(entry.id)));

    const listed = await store.list();
    const card = listed.items.find((i) => i.key === `remote:${entry.id}`);
    check('store list shows it as an installed community extension',
      !!(card && card.community && card.installed), JSON.stringify(card && { community: card.community, installed: card.installed }));

    // ---- 3. content script runs in a real tab ---------------------------
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(PAGE);
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;

    const win = new BrowserWindow({
      show: false,
      webPreferences: { partition: PARTITION, sandbox: false, contextIsolation: true },
    });
    await win.loadURL(`http://127.0.0.1:${port}/`);
    await sleep(1400);
    const badge = await win.webContents.executeJavaScript(
      `(document.getElementById('aegis-reading-time') || {}).textContent || ''`,
    );
    check(`content script rendered the badge (got "${badge.trim()}")`, /min read/i.test(badge));
    win.destroy();
    await new Promise((r) => server.close(r));

    // ---- 4. uninstall ----------------------------------------------------
    await store.uninstall(`remote:${entry.id}`);
    let remaining = [];
    for (let i = 0; i < 20; i++) {
      remaining = await ses.extensions.getAllExtensions();
      if (!remaining.some((e) => e.id === installed.id)) break;
      await sleep(100);
    }
    check('uninstall removes the extension from the session',
      !remaining.some((e) => e.id === installed.id));
    check('uninstall clears persisted state',
      !(settings.externalExtensions || []).includes(store.remoteDir(entry.id)));
  } catch (e) {
    fail++;
    console.log('  ✗ FAIL: ' + (e && e.stack ? e.stack : e));
  } finally {
    fs.rmSync(PROFILE, { recursive: true, force: true });
    console.log(`\n${pass} passed, ${fail} failed`);
    app.exit(fail ? 1 : 0);
  }
});
