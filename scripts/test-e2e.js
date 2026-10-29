'use strict';
// End-to-end test: a real tab (persist:aegis-browse partition) loads
// aegis://search?q=... and the streaming API must return ranked results.
// Run with: npx electron scripts/test-e2e.js

const { app, session, protocol, WebContentsView, BaseWindow } = require('electron');
const { SearchEngine } = require('../src/main/search/engine');
const { makeSearchHandler } = require('../src/main/search/protocol');
const { AiEngine } = require('../src/main/ai');

protocol.registerSchemesAsPrivileged([
  { scheme: 'aegis', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } },
]);

const BROWSE_PARTITION = 'persist:aegis-browse';

app.whenReady().then(async () => {
  const getSettings = () => ({
    searchSources: { web: true, knowledge: true, code: true, papers: true, discussions: true },
  });
  const ai = new AiEngine(getSettings, () => ({}));
  const search = new SearchEngine({ getSettings, ai });
  const handler = makeSearchHandler(search);

  // Mirror main.js: register on default AND the tab partition.
  protocol.handle('aegis', handler);
  session.fromPartition(BROWSE_PARTITION).protocol.handle('aegis', handler);

  const win = new BaseWindow({ width: 1000, height: 700, show: false });
  const view = new WebContentsView({
    webPreferences: { partition: BROWSE_PARTITION, contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  win.contentView.addChildView(view);
  view.setBounds({ x: 0, y: 0, width: 1000, height: 700 });

  const wc = view.webContents;
  wc.on('console-message', (e, level, message) => console.log('  [page]', String(message).slice(0, 200)));
  wc.on('did-fail-load', (e, code, desc, url) => console.log('  [did-fail-load]', code, desc, url));

  let failed = false;
  const fail = (msg) => { failed = true; console.log('✗ ' + msg); };
  const ok = (msg) => console.log('✓ ' + msg);

  try {
    console.log('— loading aegis://search?q=privacy browser —');
    await wc.loadURL('aegis://search?q=' + encodeURIComponent('privacy browser'));
    ok('search page loaded (no protocol error)');

    // wait for the page JS to fetch + render results
    let results = 0;
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 500));
      results = await wc.executeJavaScript('document.querySelectorAll(".result").length', true).catch(() => 0);
      if (results > 0) break;
    }
    if (results > 0) ok(`rendered ${results} result cards in the tab`);
    else fail('no .result cards rendered — streaming render broken');

    const meta = await wc.executeJavaScript("document.getElementById('meta').textContent", true).catch(() => '');
    console.log('  meta:', meta);
    if (meta && !/failed/i.test(meta)) ok('status meta populated');
    else fail('status meta indicates failure: ' + meta);

    // direct API check from inside the tab's origin
    const apiCount = await wc.executeJavaScript(`
      (async () => {
        const r = await fetch('aegis://search/api/search?q=' + encodeURIComponent('rust programming'));
        const text = await r.text();
        return text.split('\\n').filter(Boolean).length;
      })()
    `, true).catch((e) => { fail('fetch from tab origin threw: ' + e.message); return 0; });
    if (apiCount > 3) ok(`streaming API responded from tab origin (${apiCount} NDJSON events)`);
    else fail('streaming API returned too few events: ' + apiCount);
  } catch (e) {
    fail('exception: ' + e.message);
  }

  console.log(failed ? '\nE2E: FAILED' : '\nE2E: ALL PASS');
  app.exit(failed ? 1 : 0);
});

setTimeout(() => { console.log('E2E TIMEOUT'); app.exit(1); }, 60000);
