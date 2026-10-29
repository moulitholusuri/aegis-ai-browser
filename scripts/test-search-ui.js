'use strict';
// Search customization UI test: boots the REAL index.html + renderer.js with a
// stub API and drives the engine manager (cards, toggles, custom engines,
// sources, bangs, switcher menu).
// Run with: npx electron scripts/test-search-ui.js

const { app, BrowserWindow } = require('electron');
const os = require('os');
const path = require('path');

app.setPath('userData', path.join(os.tmpdir(), 'aegis-search-ui-test'));
app.commandLine.appendSwitch('no-sandbox');

app.whenReady().then(async () => {
  let failed = false;
  const fail = (msg) => { failed = true; console.log('✗ ' + msg); };
  const ok = (msg) => console.log('✓ ' + msg);

  const win = new BrowserWindow({
    show: false, width: 1280, height: 900,
    webPreferences: {
      preload: path.join(__dirname, 'search-ui-preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: false,
    },
  });
  const rendererErrors = [];
  win.webContents.on('console-message', (e, level, message) => {
    if (level >= 2) {
      rendererErrors.push(String(message).slice(0, 300));
      console.log('  [renderer error]', rendererErrors[rendererErrors.length - 1]);
    }
  });

  const js = (code) => win.webContents.executeJavaScript(code, true).catch((e) => {
    fail('executeJavaScript: ' + e.message);
    return null;
  });
  const poll = async (expr, tries = 30) => {
    for (let i = 0; i < tries; i++) {
      const v = await js(expr);
      if (v) return v;
      await new Promise((r) => setTimeout(r, 150));
    }
    return null;
  };
  const callsWith = (pred) => `window.__test.calls().some(c => ${pred})`;

  try {
    await win.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'index.html'));
    const booted = await poll(`!document.getElementById('browser').classList.contains('hidden')`);
    if (booted) ok('renderer booted with the search engine manager');
    else fail('renderer did not boot');

    // ---- open Settings → Search ----------------------------------------
    await js(`window.__test.reset(); openSettings('search')`);
    const opened = await poll(`!document.getElementById('overlay-settings').classList.contains('hidden')`);
    if (opened) ok('settings overlay opens (scrolled to Search)');
    else fail('settings overlay did not open');

    const cards = await poll(`document.querySelectorAll('#engine-cards .engine-card').length`);
    if (cards === 3) ok(`default-engine cards rendered (${cards})`);
    else fail('engine card count = ' + cards);

    const active = await js(`[...document.querySelectorAll('#engine-cards .engine-card')].map(c => ({
      key: c.dataset.engine, active: c.classList.contains('active'), mark: c.querySelector('.engine-mark').textContent,
      icon: c.querySelector('.engine-icon').textContent,
    }))`);
    if (active && active[0].active && active[0].mark === '✓' && active[0].icon === '🛡️') {
      ok('current default is highlighted with ✓ and its icon');
    } else {
      fail('default highlight wrong: ' + JSON.stringify(active));
    }

    const lockCheck = await js(`(() => {
      const cb = document.querySelector('#engine-toggles input[data-engine="aegis"]');
      const bing = document.querySelector('#engine-toggles input[data-engine="bing"]');
      return { aegisDisabled: cb.disabled, bingDisabled: bing.disabled };
    })()`);
    if (lockCheck && lockCheck.aegisDisabled && !lockCheck.bingDisabled) {
      ok('current default cannot be hidden; other engines can');
    } else {
      fail('toggle lock state wrong: ' + JSON.stringify(lockCheck));
    }

    // ---- switch default -------------------------------------------------
    await js(`window.__test.reset(); document.querySelector('#engine-cards .engine-card[data-engine="google"]').click()`);
    const switched = await poll(callsWith(`c[0] === 'settings.set' && c[1].searchEngine === 'google'`));
    if (switched) ok('clicking a card sets the default engine');
    else fail('searchEngine was never set to google');
    const pill = await poll(`document.getElementById('engine-btn').textContent.includes('Google')`);
    if (pill) ok('omnibox pill updates immediately');
    else fail('pill did not update: ' + await js(`document.getElementById('engine-btn').textContent`));
    const nt = await js(`document.getElementById('nt-engine-name').textContent`);
    if (nt === 'Google') ok('new-tab line follows the default engine');
    else fail('new-tab engine label = ' + nt);

    // ---- hide an engine from the switcher --------------------------------
    await js(`window.__test.reset(); document.querySelector('#engine-toggles input[data-engine="bing"]').click()`);
    const hid = await poll(callsWith(`c[0] === 'settings.set' && Array.isArray(c[1].enabledEngines) && !c[1].enabledEngines.includes('bing')`));
    if (hid) ok('toggling an engine off updates enabledEngines');
    else fail('enabledEngines never excluded bing');

    // ---- add a custom engine ---------------------------------------------
    await js(`
      window.__test.reset();
      document.getElementById('eng-name').value = 'Ecosia';
      document.getElementById('eng-url').value = 'https://www.ecosia.org/search?q=%s';
      document.getElementById('eng-bang').value = 'eco';
      document.getElementById('eng-add-btn').click();
    `);
    const added = await poll(callsWith(`c[0] === 'settings.set' && Array.isArray(c[1].customEngines) && c[1].customEngines.some(e => e.label === 'Ecosia')`));
    if (added) ok('"Add engine" submits a custom engine');
    else fail('customEngines never received Ecosia');

    const cards2 = await poll(`document.querySelectorAll('#engine-cards .engine-card').length`);
    if (cards2 === 4) ok('custom engine appears as a default-engine card');
    else fail('card count after add = ' + cards2);
    const row = await poll(`document.querySelectorAll('#eng-custom-list .eng-row').length`);
    if (row === 1) ok('custom engine listed under the form with its URL');
    else fail('custom engine row count = ' + row);
    const rowText = await js(`document.querySelector('#eng-custom-list .eng-row').textContent`);
    if (rowText && rowText.includes('Ecosia') && rowText.includes('!eco')) {
      ok('custom engine row shows the URL and bang');
    } else {
      fail('custom row text: ' + rowText);
    }

    // ---- reject a URL without %s -----------------------------------------
    await js(`
      window.__test.reset();
      document.getElementById('eng-name').value = 'Broken';
      document.getElementById('eng-url').value = 'https://broken.example/search';
      document.getElementById('eng-bang').value = '';
      document.getElementById('eng-add-btn').click();
    `);
    const rejected = await poll(`document.getElementById('eng-add-status').textContent.includes('%s')`);
    if (rejected) ok('URL without %s is rejected with a clear hint');
    else fail('invalid URL was not rejected');
    const noSubmit = await js(`window.__test.calls().some(c => c[0] === 'settings.set' && c[1].customEngines)`);
    if (!noSubmit) ok('invalid URL never reaches settings');
    else fail('invalid custom engine was submitted');

    // ---- quick switcher menu reflects everything -------------------------
    await js(`window.__test.reset(); closeOverlay('settings'); document.getElementById('engine-btn').click()`);
    const menu = await poll(`(() => {
      const items = [...document.querySelectorAll('#engine-menu .engine-item')];
      return items.length ? items.map(i => i.textContent.trim()) : null;
    })()`);
    if (menu) {
      const joined = menu.join(' | ');
      const engineItems = menu.filter((t) => t.includes('Aegis') || t.includes('Google') || t.includes('Bing') || t.includes('Ecosia'));
      if (!joined.includes('Bing')) ok('hidden engine (Bing) is absent from the switcher');
      else fail('Bing still in switcher: ' + joined);
      if (joined.includes('Ecosia')) ok('custom engine appears in the switcher');
      else fail('Ecosia missing from switcher: ' + joined);
      if (joined.includes('Add search engine') && joined.includes('Manage search engines')) {
        ok('switcher offers Add + Manage shortcuts');
      } else {
        fail('switcher shortcuts missing: ' + joined);
      }
      if (engineItems.length === 3) ok(`switcher lists exactly ${engineItems.length} engines`);
      else fail('switcher engine item count = ' + engineItems.length + ' (' + joined + ')');
    } else {
      fail('engine menu did not render');
    }

    // The native page view paints above the DOM, so opening the dropdown must
    // hide it — otherwise the menu exists but is invisible on real pages.
    const menuOverlay = await js(`window.__test.calls().some(c => c[0] === 'ui.overlay' && c[1] === 'engine-menu')`);
    if (menuOverlay) ok('opening the engine menu hides the native page view');
    else fail('engine menu did not request page-view hiding');

    await js(`window.__test.reset(); document.querySelector('#engine-menu .engine-list .engine-item').click()`);
    const menuClosed = await poll(`document.getElementById('engine-menu').classList.contains('hidden')`);
    const restored = await js(`window.__test.calls().some(c => c[0] === 'ui.overlay' && c[1] === null)`);
    if (menuClosed && restored) ok('choosing an engine closes the menu and restores the page');
    else fail(`menu close/restore failed (closed=${menuClosed}, restored=${restored})`);

    // ---- remove the custom engine ----------------------------------------
    await js(`window.__test.reset(); openSettings('search')`);
    await poll(`document.querySelectorAll('#eng-custom-list .eng-row').length === 1`);
    await js(`document.querySelector('#eng-custom-list .eng-row .h-del').click()`);
    const removed = await poll(callsWith(`c[0] === 'settings.set' && Array.isArray(c[1].customEngines) && c[1].customEngines.length === 0`));
    if (removed) ok('custom engine can be removed');
    else fail('customEngines never cleared');
    const cards3 = await poll(`document.querySelectorAll('#engine-cards .engine-card').length === 3`);
    if (cards3) ok('engine cards drop back to 3 after removal');
    else fail('cards did not drop after removal');

    // ---- Aegis source toggles --------------------------------------------
    await js(`window.__test.reset(); document.querySelector('#source-toggles input[data-source="papers"]').click()`);
    const src = await poll(callsWith(`c[0] === 'settings.set' && c[1].searchSources && c[1].searchSources.papers === false`));
    if (src) ok('Aegis AI source toggles update searchSources');
    else fail('searchSources.papers never set to false');
    const srcCount = await js(`document.querySelectorAll('#source-toggles .engine-toggle').length`);
    if (srcCount === 5) ok('all five Aegis sources are listed');
    else fail('source toggle count = ' + srcCount);

    // ---- bang chips --------------------------------------------------------
    const bangs = await js(`[...document.querySelectorAll('#bang-chips .bang-chip')].map(b => b.textContent)`);
    if (bangs && bangs.includes('!g') && bangs.includes('!a')) {
      ok(`bang chips rendered (${bangs.join(' ')})`);
    } else {
      fail('bang chips: ' + JSON.stringify(bangs));
    }
    // hidden engine's bang should not be advertised (bing was untoggled)
    if (bangs && !bangs.includes('!b')) ok('hidden engine bangs are not advertised');
    else fail('!b still advertised while Bing is hidden');

    const bangFill = await js(`(() => {
      closeOverlay('settings');
      document.querySelector('#bang-chips .bang-chip')?.click();
      return document.getElementById('omnibox').value;
    })()`);
    if (bangFill && /^!\w+ $/.test(bangFill)) ok(`bang chip pre-fills the omnibox ("${bangFill}")`);
    else fail('bang chip prefill = ' + bangFill);

    // ---- no renderer errors ------------------------------------------------
    if (rendererErrors.length === 0) ok('no renderer errors during the whole flow');
    else fail('renderer errors: ' + JSON.stringify(rendererErrors));
  } catch (e) {
    fail('exception: ' + e.message + '\n' + e.stack);
  }

  console.log(failed ? '\nSEARCH-UI: FAILED' : '\nSEARCH-UI: ALL PASS');
  app.exit(failed ? 1 : 0);
});

setTimeout(() => { console.log('SEARCH-UI TIMEOUT'); app.exit(1); }, 60000);
