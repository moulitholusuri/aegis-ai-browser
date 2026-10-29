'use strict';
// Renderer smoke test for the extension store: boots the REAL index.html +
// renderer.js with a stub API and drives the store UI by clicking it.
// Run with: npx electron scripts/test-store-ui.js

const { app, BrowserWindow } = require('electron');
const os = require('os');
const path = require('path');

app.setPath('userData', path.join(os.tmpdir(), 'aegis-store-ui-test'));
app.commandLine.appendSwitch('no-sandbox');

app.whenReady().then(async () => {
  let failed = false;
  const fail = (msg) => { failed = true; console.log('✗ ' + msg); };
  const ok = (msg) => console.log('✓ ' + msg);

  const win = new BrowserWindow({
    show: false, width: 1280, height: 840,
    webPreferences: {
      preload: path.join(__dirname, 'store-ui-preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: false,
    },
  });
  const rendererErrors = [];
  win.webContents.on('console-message', (e, level, message) => {
    if (level >= 2) { rendererErrors.push(String(message).slice(0, 300)); console.log('  [renderer error]', rendererErrors[rendererErrors.length - 1]); }
  });

  const js = (code) => win.webContents.executeJavaScript(code, true).catch((e) => {
    fail('executeJavaScript: ' + e.message);
    return null;
  });
  const poll = async (expr, tries = 25) => {
    for (let i = 0; i < tries; i++) {
      const v = await js(expr);
      if (v) return v;
      await new Promise((r) => setTimeout(r, 200));
    }
    return null;
  };

  try {
    await win.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'index.html'));

    const booted = await poll(`!document.getElementById('browser').classList.contains('hidden')`);
    if (booted) ok('real renderer booted (unlocked → browser screen)');
    else fail('renderer did not reach the browser screen');

    const boot = await poll(`document.querySelectorAll('#engine-cards .engine-card').length > 0`);
    if (boot) ok('settings loaded through the stub API');
    else fail('settings not populated');

    // ---- open the store ------------------------------------------------
    await js(`window.__test.reset(); openStore()`);
    const opened = await poll(`!document.getElementById('overlay-store').classList.contains('hidden')`);
    if (opened) ok('🧩 toolbar button opens the store overlay');
    else fail('store overlay did not open');

    const overlayHide = await poll(`window.__test.calls().some(c => c[0] === 'ui.overlay' && c[1] === 'store')`);
    if (overlayHide) ok('store asks main to hide the native page view (ui.overlay)');
    else fail('ui.overlay("store") was never called');

    const cardCount = await poll(`document.querySelectorAll('#store-grid .xcard').length`);
    if (cardCount === 2) ok(`store rendered ${cardCount} extension cards`);
    else fail('card count = ' + cardCount);

    const cardStates = await js(`[...document.querySelectorAll('#store-grid .xcard')].map(c => ({
      name: c.querySelector('.xcard-meta b').textContent,
      btn: c.querySelector('.xcard-btn').textContent,
      on: c.classList.contains('on'),
      chip: c.querySelector('.xcard-chip').textContent,
      rating: c.querySelector('.xcard-rating') ? c.querySelector('.xcard-rating').textContent : null,
    }))`);
    if (cardStates && cardStates[0].btn === 'Install' && cardStates[1].btn === 'Remove') {
      ok('card buttons reflect state (Install vs Remove)');
    } else {
      fail('card button states wrong: ' + JSON.stringify(cardStates));
    }
    if (cardStates && cardStates[0].chip === 'Appearance' && cardStates[0].rating === '★ 4.7') {
      ok('card chips + ratings rendered');
    } else {
      fail('card metadata missing: ' + JSON.stringify(cardStates && cardStates[0]));
    }

    const badge = await js(`({ text: document.getElementById('store-badge').textContent,
                               hidden: document.getElementById('store-badge').classList.contains('hidden') })`);
    if (badge && badge.text === '1' && !badge.hidden) ok('installed-count badge shows 1');
    else fail('badge wrong: ' + JSON.stringify(badge));

    const status = await js(`document.getElementById('store-status').textContent`);
    if (status && /1 active/.test(status)) ok(`store status line: "${status}"`);
    else fail('store status line = ' + status);

    // ---- install flow ---------------------------------------------------
    await js(`window.__test.reset(); document.querySelectorAll('#store-grid .xcard')[0].querySelector('.xcard-btn').click()`);
    const installed = await poll(`window.__test.calls().some(c => c[0] === 'ext.install' && c[1] === 'night-lens')`);
    if (installed) ok('Install button calls ext.install("night-lens")');
    else fail('ext.install never invoked');
    const reloaded = await poll(`window.__test.calls().some(c => c[0] === 'tabs.reload' && c[1] === 1)`);
    if (reloaded) ok('active tab reloads so the content script applies immediately');
    else fail('active tab was not reloaded after install');

    // ---- uninstall flow -------------------------------------------------
    await js(`window.__test.reset(); document.querySelectorAll('#store-grid .xcard')[1].querySelector('.xcard-btn').click()`);
    const removed = await poll(`window.__test.calls().some(c => c[0] === 'ext.uninstall' && c[1] === 'cookie-hider')`);
    if (removed) ok('Remove button calls ext.uninstall("cookie-hider")');
    else fail('ext.uninstall never invoked');

    // ---- load-unpacked flow ----------------------------------------------
    await js(`window.__test.reset(); document.getElementById('store-unpacked').click()`);
    const unpacked = await poll(`window.__test.calls().some(c => c[0] === 'ext.unpacked')`);
    if (unpacked) ok('"Load unpacked extension…" calls the native picker');
    else fail('ext.loadUnpacked never invoked');

    // ---- close -----------------------------------------------------------
    await js(`window.__test.reset(); document.getElementById('store-close').click()`);
    const closed = await poll(`document.getElementById('overlay-store').classList.contains('hidden')`);
    if (closed) ok('✕ closes the store overlay');
    else fail('store overlay did not close');
    const restored = await poll(`window.__test.calls().some(c => c[0] === 'ui.overlay' && c[1] === null)`);
    if (restored) ok('closing restores the page view (ui.overlay(null))');
    else fail('page view was not restored after close');

    // ---- no console errors during the whole flow -------------------------
    if (rendererErrors.length === 0) ok('no renderer errors during the store flow');
    else fail('renderer errors: ' + JSON.stringify(rendererErrors));
  } catch (e) {
    fail('exception: ' + e.message + '\n' + e.stack);
  }

  console.log(failed ? '\nSTORE-UI: FAILED' : '\nSTORE-UI: ALL PASS');
  app.exit(failed ? 1 : 0);
});

setTimeout(() => { console.log('STORE-UI TIMEOUT'); app.exit(1); }, 45000);
