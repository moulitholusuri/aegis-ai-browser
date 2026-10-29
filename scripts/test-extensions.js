'use strict';
// Extension store end-to-end test: a real tab (persist:aegis-browse) must run
// installed MV3 content scripts, and uninstall must remove them.
// Run with: npx electron scripts/test-extensions.js

const { app, session, WebContentsView, BaseWindow } = require('electron');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ExtensionStore } = require('../src/main/extensions');

// Isolated profile so we never touch the live app's extension state.
app.setPath('userData', path.join(os.tmpdir(), 'aegis-test-extensions'));

const BROWSE_PARTITION = 'persist:aegis-browse';

// ---- local page under test: a link with trackers + a comment block -------
const PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>ext test</title></head>
<body>
  <a id="link" href="https://example.com/article?utm_source=news&utm_medium=email&fbclid=abc123&id=42">story</a>
  <div id="comments">comment section</div>
  <div id="keep">visible content</div>
</body></html>`;

function serve() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end(PAGE);
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

app.whenReady().then(async () => {
  let failed = false;
  const fail = (msg) => { failed = true; console.log('✗ ' + msg); };
  const ok = (msg) => console.log('✓ ' + msg);

  const server = await serve();
  const url = `http://127.0.0.1:${server.address().port}/`;

  // Settings shim (in-memory, same shape main.js uses)
  const store = {};
  const extStore = new ExtensionStore({
    getSession: () => session.fromPartition(BROWSE_PARTITION),
    getSettings: () => store,
    setSettings: (patch) => Object.assign(store, patch),
  });

  const win = new BaseWindow({ width: 900, height: 600, show: false });
  const view = new WebContentsView({
    webPreferences: { partition: BROWSE_PARTITION, contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  win.contentView.addChildView(view);
  view.setBounds({ x: 0, y: 0, width: 900, height: 600 });
  const wc = view.webContents;

  const js = (code) => wc.executeJavaScript(code, true).catch((e) => { fail('executeJavaScript: ' + e.message); return null; });
  const poll = async (expr, tries = 20) => {
    for (let i = 0; i < tries; i++) {
      const v = await js(expr);
      if (v) return v;
      await new Promise((r) => setTimeout(r, 400));
    }
    return null;
  };

  try {
    // ---- catalog -----------------------------------------------------
    const list0 = await extStore.list();
    if (list0.items.length >= 5) ok(`catalog lists ${list0.items.length} bundled extensions`);
    else fail('catalog too small: ' + list0.items.length);
    if (list0.items.every((i) => !i.installed)) ok('all extensions report uninstalled on a fresh profile');
    else fail('fresh profile shows installed extensions');

    const cat = list0.items.find((i) => i.id === 'cookie-hider');
    if (cat && cat.name && cat.description && cat.rating) ok(`card metadata present (${cat.name}, ★${cat.rating})`);
    else fail('catalog card missing name/description/rating');

    // ---- baseline: page without extensions ---------------------------
    await wc.loadURL(url);
    const baseComments = await poll(`document.getElementById('comments') ? getComputedStyle(document.getElementById('comments')).display : null`);
    if (baseComments && baseComments !== 'none') ok('baseline page: comments visible (no extension yet)');
    else fail('baseline unexpected: comments display = ' + baseComments);
    const baseHref = await js(`document.getElementById('link').getAttribute('href')`);
    if (baseHref && baseHref.includes('utm_source')) ok('baseline page: tracking params present in link');
    else fail('baseline link missing trackers: ' + baseHref);

    // ---- install -----------------------------------------------------
    await extStore.install('focus-reader');
    await extStore.install('link-scrubber');
    const list1 = await extStore.list();
    const installedCount = list1.items.filter((i) => i.installed).length;
    if (installedCount === 2) ok('install() flips installed state for both extensions');
    else fail('installed count = ' + installedCount + ' (expected 2)');
    if ((store.installedExtensions || []).length === 2) ok('installed set persisted into settings');
    else fail('settings.installedExtensions = ' + JSON.stringify(store.installedExtensions));

    const liveAll = async (ses) => (ses.extensions ? ses.extensions.getAllExtensions() : ses.getAllExtensions());
    const loaded = await liveAll(session.fromPartition(BROWSE_PARTITION));
    if (loaded.length === 2) ok(`session reports ${loaded.length} live extension(s)`);
    else fail('live extensions = ' + loaded.length);

    // ---- effect: reload so content scripts run ------------------------
    await wc.loadURL(url);
    const hidden = await poll(`document.getElementById('comments') ? getComputedStyle(document.getElementById('comments')).display === 'none' : false`);
    if (hidden) ok('focus-reader content script hid #comments in a real tab');
    else fail('focus-reader did not apply');

    const visible = await poll(`document.getElementById('keep') ? getComputedStyle(document.getElementById('keep')).display !== 'none' : false`);
    if (visible) ok('focus-reader left unrelated content visible');
    else fail('focus-reader hid too much');

    const scrubbed = await poll(`(document.getElementById('link').getAttribute('href') || '').includes('utm_source') === false`);
    if (scrubbed) {
      const href = await js(`document.getElementById('link').getAttribute('href')`);
      if (href.includes('id=42')) ok(`link-scrubber stripped trackers but kept real params (${href})`);
      else fail('link-scrubber ate legitimate params: ' + href);
    } else {
      fail('link-scrubber did not strip utm_source');
    }

    // ---- uninstall ---------------------------------------------------
    await extStore.uninstall('focus-reader');
    await extStore.uninstall('link-scrubber');
    const list2 = await extStore.list();
    if (list2.items.filter((i) => i.installed).length === 0) ok('uninstall() clears installed state');
    else fail('extensions still installed after uninstall');
    if ((store.installedExtensions || []).length === 0) ok('settings cleaned after uninstall');
    else fail('settings still hold: ' + JSON.stringify(store.installedExtensions));
    const loaded2 = await liveAll(session.fromPartition(BROWSE_PARTITION));
    if (loaded2.length === 0) ok('session no longer has the extensions loaded');
    else fail('session still holds ' + loaded2.length + ' extension(s)');

    await wc.loadURL(url);
    const back = await poll(`document.getElementById('comments') ? getComputedStyle(document.getElementById('comments')).display !== 'none' : false`);
    if (back) ok('page renders normally again after uninstall');
    else fail('content script effect lingered after uninstall');

    // ---- load unpacked ------------------------------------------------
    const unpackedDir = path.join(os.tmpdir(), 'aegis-unpacked-ext-' + Date.now());
    fs.mkdirSync(unpackedDir, { recursive: true });
    fs.writeFileSync(path.join(unpackedDir, 'manifest.json'), JSON.stringify({
      manifest_version: 3,
      name: 'Unpacked Probe',
      version: '0.1.0',
      description: 'Temporary extension used by the test suite.',
      content_scripts: [{ matches: ['<all_urls>'], js: ['c.js'], run_at: 'document_idle' }],
    }));
    fs.writeFileSync(path.join(unpackedDir, 'c.js'), 'document.title = "unpacked-ran";');
    try {
      const u = await extStore.loadUnpacked(unpackedDir);
      if (u.ok && u.name === 'Unpacked Probe') ok('loadUnpacked() accepts a valid manifest folder');
      else fail('loadUnpacked returned ' + JSON.stringify(u));
      const list3 = await extStore.list();
      const ext = list3.items.find((i) => i.external);
      if (ext && ext.installed) ok('unpacked extension appears in the store list');
      else fail('unpacked extension missing from list');
      await extStore.uninstall(unpackedDir);
      const list4 = await extStore.list();
      if (!list4.items.some((i) => i.external)) ok('unpacked extension removable from the store');
      else fail('unpacked extension still listed after removal');
    } catch (e) {
      fail('loadUnpacked threw: ' + e.message);
    }

    // ---- invalid folder rejected ---------------------------------------
    try {
      await extStore.loadUnpacked(os.tmpdir());
      fail('loadUnpacked accepted a folder without manifest.json');
    } catch (e) {
      ok('loadUnpacked rejects folders without manifest.json');
    }

    // ---- startup reload path (simulated restart) -----------------------
    await extStore.install('night-lens');
    const n1 = (await extStore.list()).items.find((i) => i.id === 'night-lens');
    if (n1 && n1.installed) ok('re-install after prior uninstall works (id map reset cleanly)');
    else fail('re-install failed');
    await extStore.loadInstalled(); // must be a no-op when already loaded
    const live = await liveAll(session.fromPartition(BROWSE_PARTITION));
    if (live.length === 1) ok('loadInstalled() is idempotent with a live extension');
    else fail('loadInstalled duplicated or dropped extensions: ' + live.length);
    await extStore.uninstall('night-lens');
  } catch (e) {
    fail('exception: ' + e.message + '\n' + e.stack);
  }

  console.log(failed ? '\nEXT: FAILED' : '\nEXT: ALL PASS');
  server.close();
  app.exit(failed ? 1 : 0);
});

setTimeout(() => { console.log('EXT TIMEOUT'); app.exit(1); }, 90000);
