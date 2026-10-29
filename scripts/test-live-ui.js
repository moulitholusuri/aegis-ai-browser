'use strict';
// Real-app UI test: launches the ACTUAL main process with a throwaway profile,
// enrolls a TOTP authenticator, unlocks, and checks the things that only exist
// in the real window (native page views vs chrome overlays).
// Run with: node scripts/test-live-ui.js

const { spawn } = require('child_process');
const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { b32decode, totp } = require('../src/main/crypto-utils');

const PORT = 9417;
const APP = path.join(__dirname, '..');
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-live-'));
const PASS = 'aegis-live-test-pass';
const USER = 'Aegis Tester';

let pass = 0, fail = 0;
const check = (name, cond) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function activateApp() {
  try {
    require('child_process').execFileSync('osascript', ['-e', 'tell application "Electron" to activate'], { stdio: 'ignore' });
  } catch { /* accessibility may be blocked */ }
}

async function shot(file) {
  try {
    await sleep(700);
    require('child_process').execFileSync('screencapture', ['-x', file]);
    console.log('  · screenshot: ' + file);
  } catch { /* ignore */ }
}

function getJSON(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

class CDP {
  constructor(url) { this.url = url; this.id = 0; this.pending = new Map(); }
  async open() {
    this.ws = new WebSocket(this.url);
    await new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = rej; });
    this.ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        this.pending.get(msg.id)(msg);
        this.pending.delete(msg.id);
      }
    };
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression, awaitPromise: true, returnByValue: true, userGesture: true,
    });
    if (r.result && r.result.exceptionDetails) {
      throw new Error('eval: ' + (r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text));
    }
    return r.result && r.result.result ? r.result.result.value : undefined;
  }
  close() { try { this.ws.close(); } catch { /* ignore */ } }
}

async function findTarget(match, tries = 80) {
  for (let i = 0; i < tries; i++) {
    try {
      const list = await getJSON(`http://127.0.0.1:${PORT}/json`);
      const t = list.find(match);
      if (t && t.webSocketDebuggerUrl) return t;
    } catch { /* not up yet */ }
    await sleep(400);
  }
  return null;
}

async function waitFor(cdp, expr, ms = 15000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await cdp.eval(expr)) return true;
    await sleep(300);
  }
  return false;
}

(async () => {
  const electron = require('electron');
  const child = spawn(electron, ['.', `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`], {
    cwd: APP, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logs = [];
  child.stdout.on('data', (d) => logs.push(String(d)));
  child.stderr.on('data', (d) => logs.push(String(d)));

  let chrome;
  let page;
  try {
    console.log('— launching the real app —');
    const chromeTarget = await findTarget((t) => t.type === 'page' && /index\.html/.test(t.url));
    if (!chromeTarget) throw new Error('chrome UI target not found\n' + logs.join(''));
    chrome = new CDP(chromeTarget.webSocketDebuggerUrl);
    await chrome.open();
    await chrome.send('Runtime.enable');
    check('app window launched and chrome UI loaded', true);

    // ---- enroll a throwaway authenticator --------------------------------
    const atSetup = await waitFor(chrome, `!document.getElementById('screen-setup').classList.contains('hidden')`);
    check('setup screen shown for a fresh profile', atSetup);

    await chrome.eval(`(() => {
      document.getElementById('setup-user').value = ${JSON.stringify(USER)};
      document.getElementById('setup-pass').value = ${JSON.stringify(PASS)};
      document.getElementById('setup-pass2').value = ${JSON.stringify(PASS)};
      document.getElementById('setup-next').click();
    })()`);
    const atQr = await waitFor(chrome, `!document.getElementById('setup-qr-card').classList.contains('hidden')`);
    check('TOTP secret + QR generated', atQr);

    const secretText = await chrome.eval(`document.getElementById('setup-secret').textContent.replace(/\\s+/g, '')`);
    const code = totp(b32decode(secretText));
    await chrome.eval(`(() => {
      document.getElementById('setup-code').value = ${JSON.stringify(code)};
      document.getElementById('setup-confirm').click();
    })()`);
    const unlocked = await waitFor(chrome, `!document.getElementById('browser').classList.contains('hidden')`, 20000);
    check('browser unlocked with a valid TOTP code', unlocked);

    // ---- new tab hero (chrome UI, not an about:blank page) ---------------
    const tabsReady = await waitFor(chrome, `state.tabs && state.tabs.length > 0 && state.tabs.some(t => t.active)`, 20000);
    check('tab list is ready', tabsReady);

    const hero = await waitFor(chrome, `(() => {
      const nt = document.getElementById('newtab');
      return getComputedStyle(nt).display !== 'none';
    })()`);
    check('new tab shows the Aegis hero (view hidden)', hero);

    const tabUrl = await chrome.eval(`state.tabs.find(t => t.active)?.url`);
    check(`new tab keeps its aegis://newtab identity (got ${tabUrl})`, tabUrl === 'aegis://newtab');
    const omni = await chrome.eval(`document.getElementById('omnibox').value`);
    check('new tab address bar stays empty', omni === '');
    const ntEngine = await chrome.eval(`document.getElementById('nt-engine-name').textContent`);
    check('new tab shows the current engine name', /Aegis|Google|Bing|DuckDuckGo/.test(ntEngine));

    // Chrome-only capture (no native view on a new tab) for the theme.
    const cap = await chrome.send('Page.captureScreenshot', { format: 'png' });
    if (cap.result && cap.result.data) {
      fs.writeFileSync('/tmp/aegis-live-newtab.png', Buffer.from(cap.result.data, 'base64'));
      console.log('  · screenshot: /tmp/aegis-live-newtab.png');
    }
    const stamp = await chrome.eval(`(() => {
      const e = document.getElementById('made-in-india');
      if (!e) return null;
      const r = e.getBoundingClientRect();
      return { text: e.textContent.trim(), x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width) };
    })()`);
    check('Indian Made stamp sits in the bottom-right corner',
      !!stamp && /indian\s*made/i.test(stamp.text) && stamp.x > 900);

    const homeStamp = await chrome.eval(`(() => {
      const e = document.getElementById('home-stamp');
      if (!e) return null;
      const r = e.getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height), right: Math.round(innerWidth - r.right), bottom: Math.round(innerHeight - r.bottom), display: getComputedStyle(e).display };
    })()`);
    check('home page shows the big Indian Made seal',
      !!homeStamp && homeStamp.w >= 110 && homeStamp.display !== 'none');

    // ---- navigate to a real page, then open the dropdown ------------------
    const navResult = await chrome.eval(`api.tabs.navigate(state.activeTabId, 'https://example.com')`);
    console.log('  · navigate →', JSON.stringify(navResult));
    await sleep(2500);
    const navigated = await waitFor(chrome,
      `document.getElementById('newtab').style.display === 'none'
       && (state.tabs.find(t => t.active)?.url || '').startsWith('https://example.com')`, 20000);
    check('real page loads and replaces the hero', navigated);

    // The page is a native WebContentsView; grab its target to read visibility.
    page = await findTarget((t) => t.type === 'page' && /example\.com/.test(t.url), 40);
    let pageCdp = null;
    if (page) {
      pageCdp = new CDP(page.webSocketDebuggerUrl);
      await pageCdp.open();
      await pageCdp.send('Runtime.enable');
    }
    const visOpen = pageCdp && await pageCdp.eval(`document.visibilityState`);

    await chrome.send('Page.bringToFront');
    activateApp();
    await sleep(1200);
    if (pageCdp) {
      const visBase = await pageCdp.eval(`document.visibilityState`);
      console.log('  · page visibility before menu →', visBase);
    }
    await chrome.eval(`document.getElementById('engine-btn').click()`);
    await sleep(700);
    const menuOpen = await chrome.eval(`!document.getElementById('engine-menu').classList.contains('hidden')`);
    check('clicking the engine pill opens the options menu', menuOpen);
    const itemCount = await chrome.eval(`document.querySelectorAll('#engine-menu .engine-list .engine-item').length`);
    check(`menu lists the enabled engines (${itemCount})`, itemCount >= 2);
    const footVisible = await chrome.eval(`(() => {
      const f = document.querySelector('#engine-menu .engine-foot');
      if (!f) return false;
      const r = f.getBoundingClientRect();
      const m = document.getElementById('engine-menu').getBoundingClientRect();
      return r.bottom <= m.bottom + 1 && r.top >= m.top;
    })()`);
    check('Add / Manage actions are inside the visible menu', footVisible);

    const visWithMenu = pageCdp && await pageCdp.eval(`document.visibilityState`);
    if (pageCdp) {
      check('page view is hidden while the menu is open', visWithMenu === 'hidden');
    } else {
      console.log('  · page target not exposed; skipped visibility probe');
    }

    // Screenshot the real window for visual proof.
    await shot('/tmp/aegis-live-menu.png');

    // ---- close the menu: the page must come back --------------------------
    await chrome.eval(`document.body.click()`);
    await sleep(500);
    const menuClosed = await chrome.eval(`document.getElementById('engine-menu').classList.contains('hidden')`);
    check('clicking outside closes the menu', menuClosed);
    if (pageCdp) {
      let visAfter = '';
      for (let i = 0; i < 12; i++) {
        visAfter = await pageCdp.eval(`document.visibilityState`);
        if (visAfter === 'visible') break;
        await sleep(400);
      }
      check(`page view is restored after closing the menu (got ${visAfter})`, visAfter === 'visible');
    }

    // ---- settings → Search is visible over the page ----------------------
    await chrome.eval(`openSettings('search')`);
    await sleep(900);
    const settingsOpen = await chrome.eval(`!document.getElementById('overlay-settings').classList.contains('hidden')`);
    check('Settings → Search opens', settingsOpen);
    const cards = await chrome.eval(`document.querySelectorAll('#engine-cards .engine-card').length`);
    check(`engine options are rendered (${cards} cards)`, cards >= 8);
    const hints = await chrome.eval(`document.querySelectorAll('#engine-cards .engine-card .engine-name').length`);
    check('every card has a readable label', hints === cards);
    const closeBtn = await chrome.eval(`(() => {
      const b = document.getElementById('settings-close');
      if (!b) return false;
      const r = b.getBoundingClientRect();
      return r.top >= 0 && r.bottom <= innerHeight;
    })()`);
    check('close button stays visible while scrolled to Search', closeBtn);

    await chrome.send('Page.bringToFront');
    activateApp();
    await shot('/tmp/aegis-live-settings.png');

    await chrome.eval(`closeOverlay('settings')`);
    if (pageCdp) {
      await sleep(500);
      const visBack = await pageCdp.eval(`document.visibilityState`);
      check('closing Settings restores the page view', visBack === 'visible');
      pageCdp.close();
    }

    // ---- auth: username label, generic error, lock/unlock -----------------
    await chrome.eval(`api.auth.lock()`);
    const atLogin = await waitFor(chrome, `!document.getElementById('screen-login').classList.contains('hidden')`);
    check('locking shows the sign-in screen', atLogin);
    const accountUi = await chrome.eval(`({
      hasField: !document.getElementById('login-user-label').classList.contains('hidden'),
      value: document.getElementById('login-user').value,
      hasSignup: !!document.getElementById('login-newuser'),
    })`);
    check('sign-in shows the enrolled username', accountUi.hasField && accountUi.value === USER);
    check('sign-in offers a new-user signup option', accountUi.hasSignup);
    await shot('/tmp/aegis-live-login.png');

    await chrome.eval(`(() => {
      document.getElementById('login-user').value = 'Wrong User';
      document.getElementById('login-pass').value = 'definitely-wrong';
      document.getElementById('login-code').value = '000000';
      document.getElementById('login-go').click();
    })()`);
    await sleep(1500);
    const wrongMsg = await chrome.eval(`document.getElementById('login-error').textContent`);
    check(`wrong credentials say "Credentials mismatching" (got "${wrongMsg}")`,
      /credentials mismatching/i.test(wrongMsg));

    const freshCode = totp(b32decode(secretText));
    await chrome.eval(`(() => {
      document.getElementById('login-user').value = ${JSON.stringify(USER)};
      document.getElementById('login-pass').value = ${JSON.stringify(PASS)};
      document.getElementById('login-code').value = ${JSON.stringify(freshCode)};
      document.getElementById('login-go').click();
    })()`);
    const backIn = await waitFor(chrome, `!document.getElementById('browser').classList.contains('hidden')`, 20000);
    check('correct username + passphrase + TOTP unlocks again', backIn);
  } catch (e) {
    fail++;
    console.log('✗ exception: ' + e.message);
    if (logs.length) console.log(logs.join('').slice(-1500));
  } finally {
    try { child.kill('SIGKILL'); } catch { /* ignore */ }
    setTimeout(() => {
      try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch { /* ignore */ }
      console.log(`\n${pass} passed, ${fail} failed`);
      process.exit(fail ? 1 : 0);
    }, 800);
  }
})();
