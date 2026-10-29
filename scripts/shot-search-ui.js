'use strict';
// Capture screenshots of the real UI for visual review.
// Run with: npx electron scripts/shot-search-ui.js
const { app, BrowserWindow } = require('electron');
const os = require('os');
const path = require('path');
const fs = require('fs');

app.setPath('userData', path.join(os.tmpdir(), 'aegis-shot'));
app.commandLine.appendSwitch('no-sandbox');

const OUT = '/tmp/aegis-shots';

app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const win = new BrowserWindow({
    show: true, width: 1280, height: 900,
    backgroundColor: '#0b0f14',
    webPreferences: {
      preload: path.join(__dirname, 'shot-preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: false,
    },
  });
  win.setAlwaysOnTop(true);

  const js = (code) => win.webContents.executeJavaScript(code, true).catch((e) => {
    console.log('js error:', e.message); return null;
  });
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const shot = async (name) => {
    const img = await win.webContents.capturePage();
    const file = path.join(OUT, name + '.png');
    fs.writeFileSync(file, img.toPNG());
    console.log('saved', file);
  };

  await win.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'index.html'));
  await wait(900);

  // Sign-in screen (theme check)
  await js(`show('screen-login')`);
  await wait(500);
  await shot('00-login');
  await js(`show('browser')`);

  // New-tab hero (the page view is hidden here in the real app)
  await js(`state.tabs = [{ id: 1, title: 'New Tab', url: 'aegis://newtab', favicon: '', loading: false, canGoBack: false, canGoForward: false, active: true }]; renderTabs()`);
  await wait(500);
  await shot('01-newtab');

  await js(`openSettings('search')`);
  await wait(1400);
  await shot('02-settings-search');

  // Scroll further down the search section
  await js(`document.getElementById('overlay-settings').querySelector('.overlay-card').scrollTop = 520`);
  await wait(500);
  await shot('03-settings-search-lower');

  // Engine switcher menu
  await js(`closeOverlay('settings')`);
  await wait(500);
  await js(`document.getElementById('engine-btn').click()`);
  await wait(500);
  await shot('04-engine-menu');

  // Store (for comparison / general layout sanity)
  await js(`document.getElementById('engine-menu').classList.add('hidden'); openStore()`);
  await wait(900);
  await shot('05-store');

  app.exit(0);
});

setTimeout(() => { console.log('SHOT TIMEOUT'); app.exit(1); }, 60000);
