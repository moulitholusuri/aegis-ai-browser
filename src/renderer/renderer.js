'use strict';
/* Aegis renderer — UI only. All privileged work happens in the main process. */

const $ = (id) => document.getElementById(id);
const api = window.aegis;

let state = {
  tabs: [],
  activeTabId: null,
  settings: {},
  account: null,
};

// ---------------- helpers ----------------
function toast(msg, kind = 'info') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  $('toasts').appendChild(el);
  setTimeout(() => el.remove(), 4200);
}

function show(screen) {
  for (const id of ['screen-setup', 'screen-login', 'browser']) $(id).classList.add('hidden');
  if (screen) $(screen).classList.remove('hidden');
}

function fmtTime(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  const diff = (Date.now() - ts) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  return d.toLocaleString();
}

// IPC errors arrive as "Error invoking remote method 'x': Error: real message".
// Show only the part the user can act on.
function errText(e) {
  const raw = String((e && e.message) || e || 'Something went wrong.');
  const i = raw.lastIndexOf('Error: ');
  return i >= 0 ? raw.slice(i + 7) : raw;
}

// ---------------- viewport sync (positions the page view under the chrome) ----------------
function sendViewport() {
  const vp = $('viewport').getBoundingClientRect();
  api.ui.viewport({ x: Math.round(vp.x), y: Math.round(vp.y), width: Math.round(vp.width), height: Math.round(vp.height) });
}
window.addEventListener('resize', sendViewport);
new ResizeObserver(sendViewport).observe($('viewport'));

// ---------------- tabs UI ----------------
function renderTabs() {
  const wrap = $('tabs');
  wrap.innerHTML = '';
  for (const t of state.tabs) {
    const el = document.createElement('div');
    el.className = 'tab' + (t.active ? ' active' : '');
    el.title = t.url;

    if (t.favicon) {
      const img = document.createElement('img');
      img.src = t.favicon;
      el.appendChild(img);
    }
    const title = document.createElement('span');
    title.className = 'tab-title';
    title.textContent = t.loading ? 'Loading…' : (t.title || 'New Tab');
    el.appendChild(title);

    const close = document.createElement('button');
    close.className = 'tab-close';
    close.textContent = '✕';
    close.onclick = (e) => { e.stopPropagation(); api.tabs.close(t.id); };
    el.appendChild(close);

    el.onclick = () => api.tabs.activate(t.id);
    wrap.appendChild(el);
  }
  const active = state.tabs.find((t) => t.active);
  state.activeTabId = active ? active.id : null;
  if (active) {
    $('btn-back').disabled = !active.canGoBack;
    $('btn-forward').disabled = !active.canGoForward;
    $('btn-reload').textContent = active.loading ? '✕' : '⟳';
    if (document.activeElement !== $('omnibox')) {
      // New tabs keep the address bar empty (never show about:blank / aegis://).
      $('omnibox').value = active.url && active.url !== 'aegis://newtab' ? active.url : '';
    }
    $('newtab').style.display = active.url === 'aegis://newtab' ? 'flex' : 'none';
  }
}

api.tabs.onChanged((list) => { state.tabs = list; renderTabs(); });

// ---------------- auth flow ----------------
async function boot() {
  const status = await api.auth.status();
  state.account = status;
  if (!status.configured) show('screen-setup');
  else if (!status.unlocked) { show('screen-login'); applyLoginAccount(status); }
  else enterBrowser();
}

// The username is a sign-in label, not part of the encryption key. Legacy
// profiles don't have one yet — hide the field until Settings sets it.
function applyLoginAccount(status) {
  const has = !!(status && status.hasUsername);
  $('login-user-label').classList.toggle('hidden', !has);
  $('login-user').value = has ? (status.username || '') : '';
}

$('setup-next').onclick = async () => {
  const user = $('setup-user').value.trim();
  const p1 = $('setup-pass').value, p2 = $('setup-pass2').value;
  const err = $('setup-error');
  err.textContent = '';
  if (!user) return (err.textContent = 'Choose a username first.');
  if (p1.length < 8) return (err.textContent = 'Passphrase must be at least 8 characters.');
  if (p1 !== p2) return (err.textContent = 'Passphrases do not match.');
  try {
    const { qr, secret } = await api.auth.setup(user, p1);
    $('setup-qr').src = qr;
    $('setup-secret').textContent = secret.replace(/(.{4})/g, '$1 ').trim();
    $('screen-setup').querySelector('.auth-card').classList.add('hidden');
    $('setup-qr-card').classList.remove('hidden');
  } catch (e) { err.textContent = errText(e); }
};

$('setup-confirm').onclick = async () => {
  const err = $('setup-confirm-error');
  err.textContent = '';
  try {
    await api.auth.confirm($('setup-code').value.trim());
    enterBrowser();
  } catch (e) { err.textContent = errText(e); }
};

$('login-go').onclick = async () => {
  const err = $('login-error');
  err.textContent = '';
  const user = $('login-user-label').classList.contains('hidden') ? '' : $('login-user').value.trim();
  try {
    await api.auth.login(user, $('login-pass').value, $('login-code').value.trim());
    enterBrowser();
  } catch (e) {
    err.textContent = errText(e);
    $('login-code').value = '';
  }
};

$('login-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('login-go').click(); });
$('login-pass').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('login-code').focus(); });

// New-user signup lives on the login screen. Aegis is a single-profile browser
// (one encrypted vault per install), so creating a new account replaces the old
// one after an explicit confirmation.
$('login-newuser').onclick = async () => {
  if (!confirm('Create a new account?\n\nAegis keeps one profile per installation. The current account and its encrypted history will be erased on this device. This cannot be undone.')) return;
  await api.auth.wipe();
  location.reload();
};

$('login-wipe').onclick = async () => {
  if (!confirm('Erase ALL Aegis data (history vault, keys, settings) and start over?')) return;
  await api.auth.wipe();
  location.reload();
};

api.auth.onLocked(async (info) => {
  if ($('browser').classList.contains('hidden')) return;
  show('screen-login');
  try {
    state.account = await api.auth.status();
    applyLoginAccount(state.account);
  } catch { /* keep cached account */ }
  $('login-pass').value = '';
  $('login-code').value = '';
  $('login-error').textContent = info.reason === 'idle' ? 'Auto-locked after inactivity.' : '';
  toast('🔒 Browser locked — sign in again', 'warn');
});

async function enterBrowser() {
  show('browser');
  await new Promise((r) => setTimeout(r, 60));
  sendViewport();
  const list = await api.tabs.list();
  if (!list.length) api.tabs.create();
  else { state.tabs = list; renderTabs(); }
  loadSettings();
  refreshPrivacyStats();
}

// ---------------- toolbar ----------------
$('btn-newtab').onclick = () => api.tabs.create();
$('btn-back').onclick = () => state.activeTabId && api.tabs.back(state.activeTabId);
$('btn-forward').onclick = () => state.activeTabId && api.tabs.forward(state.activeTabId);
$('btn-reload').onclick = () => {
  const t = state.tabs.find((x) => x.id === state.activeTabId);
  if (!t) return;
  t.loading ? api.tabs.stop(t.id) : api.tabs.reload(t.id);
};
$('btn-lock').onclick = async () => { await api.auth.lock(); };

function omniboxGo(input) {
  const text = (input || $('omnibox').value).trim();
  if (!text || !state.activeTabId) return;
  api.tabs.navigate(state.activeTabId, text);
}
$('omnibox').addEventListener('keydown', (e) => { if (e.key === 'Enter') omniboxGo(); });
$('omnibox-ai').onclick = () => { openAiPanel(); $('ai-question').value = $('omnibox').value; $('ai-question').focus(); };

$('newtab-search').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    const v = $('newtab-search').value.trim();
    if (!v) return;
    $('omnibox').value = v;
    omniboxGo(v);
    $('newtab-search').value = '';
  }
});

$('btn-clean').onclick = async () => {
  const r = await api.privacy.clean('all');
  toast(`🧹 Cleaned — ${r.cookies} cookies removed`, 'ok');
  refreshPrivacyStats();
};

// ---------------- AI panel ----------------
function openAiPanel() { $('ai-panel').classList.remove('hidden'); sendViewport(); }
function closeAiPanel() { $('ai-panel').classList.add('hidden'); sendViewport(); }
$('btn-ai').onclick = () => $('ai-panel').classList.contains('hidden') ? openAiPanel() : closeAiPanel();
$('ai-close').onclick = closeAiPanel;

function aiOut(text) { $('ai-output').textContent = text; }

$('ai-summarize').onclick = async () => {
  if (!state.activeTabId) return;
  aiOut('Summarizing…');
  const r = await api.ai.summarize(state.activeTabId);
  aiOut(`[${r.mode.toUpperCase()} AI]\n\n${r.summary}`);
};
$('ai-ask').onclick = askAi;
$('ai-question').addEventListener('keydown', (e) => { if (e.key === 'Enter') askAi(); });
async function askAi() {
  const q = $('ai-question').value.trim();
  if (!q || !state.activeTabId) return;
  aiOut('Thinking…');
  const r = await api.ai.ask(state.activeTabId, q);
  aiOut(`[${r.mode.toUpperCase()} AI]\n\n${r.answer}`);
}

$('ai-run').onclick = async () => {
  const task = $('ai-task').value.trim();
  if (!task) return;
  aiOut('🤖 Autopilot running…');
  const r = await api.ai.autopilot(task);
  aiOut(`🤖 Autopilot [${r.mode}] finished:\n\n${r.log.join('\n')}`);
};
api.ai.onAutopilotProgress((p) => aiOut(`🤖 Autopilot running…\n\n${p.log.join('\n')}`));

// Requests triggered from the omnibox (e.g. "what is X?" typed in the bar)
api.ai.onAskRequest(async ({ tabId, question }) => {
  openAiPanel();
  $('ai-question').value = question;
  aiOut('Thinking…');
  const r = await api.ai.ask(tabId, question);
  aiOut(`[${r.mode.toUpperCase()} AI]\n\n${r.answer}`);
});
api.ai.onSummarizeRequest(async ({ tabId }) => {
  openAiPanel();
  aiOut('Summarizing…');
  const r = await api.ai.summarize(tabId);
  aiOut(`[${r.mode.toUpperCase()} AI]\n\n${r.summary}`);
});

// ---------------- diagnostics: ErrorModel attached to the assistant ----------------
// Proactive: when a NEW error is recorded anywhere in the app, the assistant
// bumps the 🤖 badge (count of unseen issues), announces it (errors only, so
// warnings don't spam), and speaks it into the conversation if the panel is open.
api.ai.onDiagEvent((ev) => {
  const badge = $('ai-badge');
  const unread = ev.unread || 0;
  if (unread > 0) { badge.textContent = String(unread); badge.classList.remove('hidden'); }
  else badge.classList.add('hidden');
  if (!ev.isNew) return;
  if (ev.severity === 'error') toast(`⚠️ ${ev.title} — logged (×${ev.count})`, 'warn');
  if (!$('ai-panel').classList.contains('hidden')) {
    $('ai-output').textContent += `\n\n⚠️ ${ev.title} — ${String(ev.message).slice(0, 140)} (×${ev.count})`;
  }
});

// Health report: WHAT errors the app is facing and HOW MANY times each occurred,
// with the model's plain-language explanation and fix for every group.
async function runHealthReport() {
  openAiPanel();
  aiOut('🩺 Checking application health…');
  try {
    const r = await api.ai.diagnose();
    const report = r.report || { groups: 0, top: [] };
    const lines = (report.top || []).map((g, i) => {
      const last = new Date(g.lastSeen).toLocaleTimeString();
      return `${i + 1}. [×${g.count} · last ${last}] ${g.title}\n   ${String(g.message).slice(0, 140)}\n   → ${g.advice}`;
    });
    const sources = Object.entries(report.bySource || {})
      .map(([k, v]) => `${k} ×${v}`).join(' · ');
    const header = report.groups
      ? `${report.groups} distinct issue(s) · ${report.events} occurrence(s) total${sources ? `\n   by source: ${sources}` : ''}`
      : '✅ No errors recorded — the application is healthy.';
    aiOut(`[${String(r.mode || 'local').toUpperCase()} AI]\n\n${r.text}\n\n— — —\n${header}${lines.length ? `\n\n${lines.join('\n\n')}` : ''}`);
  } catch (err) {
    aiOut(`🩺 Health report failed: ${(err && err.message) || err}`);
  }
  $('ai-badge').classList.add('hidden');
  api.diag.seen().catch(() => {});
}
$('ai-health').onclick = runHealthReport;
api.ai.onDiagnoseRequest(runHealthReport);

// ---------------- history ----------------
$('btn-history').onclick = openHistory;
$('history-close').onclick = () => closeOverlay('history');
$('history-search').addEventListener('input', () => loadHistory());
$('history-clear').onclick = async () => {
  if (!confirm('Permanently clear encrypted history?')) return;
  await api.history.clear();
  loadHistory();
};

// Close a chrome panel. The history sidebar just shrinks the viewport back
// (ResizeObserver → main re-bounds the page view automatically). Settings is a
// modal that hid the page view underneath, so restore it explicitly.
// NOTE: $ takes a plain element ID ("overlay-history"), not a selector.
function closeOverlay(name) {
  $(`overlay-${name}`).classList.add('hidden');
  // Modal overlays (settings, store) hide the native page view underneath —
  // sidebars (history) don't, so only modals need the view restored.
  if (name === 'settings' || name === 'store') api.ui.overlay(null);
}

async function openHistory() {
  // Sidebar: opening it shrinks #viewport via flex layout → ResizeObserver →
  // main re-bounds the native page view, so the page stays visible beside it.
  $('overlay-history').classList.remove('hidden');
  $('history-search').value = '';
  await loadHistory();
}

async function loadHistory() {
  const res = await api.history.list($('history-search').value, 300);
  const list = $('history-list');
  list.innerHTML = '';
  if (res.error) { list.textContent = '🔒 Locked — unlock to view history.'; return; }
  if (!res.entries.length) { list.innerHTML = '<p class="muted">No history yet.</p>'; return; }
  for (const e of res.entries) {
    const item = document.createElement('div');
    item.className = 'history-item';
    const main = document.createElement('div');
    main.className = 'h-main';
    const title = document.createElement('div');
    title.className = 'h-title';
    title.textContent = e.title || e.host;
    const url = document.createElement('div');
    url.className = 'h-url';
    url.textContent = e.url;
    main.append(title, url);
    main.onclick = () => {
      closeOverlay('history');
      $('omnibox').value = e.url;
      omniboxGo(e.url);
    };
    const time = document.createElement('span');
    time.className = 'h-time';
    time.textContent = fmtTime(e.ts);
    const del = document.createElement('button');
    del.className = 'h-del';
    del.textContent = '🗑';
    del.onclick = async () => { await api.history.delete(e.id); loadHistory(); };
    item.append(main, time, del);
    list.appendChild(item);
  }
}

// ---------------- settings ----------------
$('btn-settings').onclick = openSettings;
$('settings-close').onclick = () => closeOverlay('settings');

// ---------------- extension store ----------------
let pubDir = null, pubEntry = null, pubZip = null, pubSubmit = null;

$('btn-store').onclick = openStore;
$('store-close').onclick = () => closeOverlay('store');

$('store-tab-browse').onclick = () => showStoreTab('browse');
$('store-tab-publish').onclick = () => showStoreTab('publish');

function showStoreTab(tab) {
  $('store-tab-browse').classList.toggle('active', tab === 'browse');
  $('store-tab-publish').classList.toggle('active', tab === 'publish');
  $('store-browse').classList.toggle('hidden', tab !== 'browse');
  $('store-publish').classList.toggle('hidden', tab !== 'publish');
}

$('store-unpacked').onclick = async () => {
  try {
    const r = await api.ext.loadUnpacked();
    if (r.canceled) return;
    if (!r.ok) { toast(`🧩 ${r.error || 'Could not load extension'}`, 'warn'); return; }
    toast(`🧩 Loaded ${r.name}`, 'ok');
    await loadStore();
  } catch (err) {
    toast(`🧩 ${errText(err)}`, 'warn');
  }
};

$('store-refresh').onclick = async () => {
  const btn = $('store-refresh');
  btn.disabled = true;
  btn.textContent = 'Refreshing…';
  try {
    const r = await api.ext.refresh();
    if (r && r.ok) {
      toast(`🧩 Community catalog: ${r.count} extension(s)`, 'ok');
      await loadStore();
    } else {
      toast(`🧩 ${(r && r.error) || 'Could not refresh the catalog'}`, 'warn');
    }
  } catch (err) {
    toast(`🧩 ${errText(err)}`, 'warn');
  }
  btn.disabled = false;
  btn.textContent = '↻ Refresh community';
};

$('store-url-toggle').onclick = () => {
  const row = $('store-url-row');
  row.classList.toggle('hidden');
  if (!row.classList.contains('hidden')) $('store-url').focus();
};

$('store-url-go').onclick = async () => {
  const url = $('store-url').value.trim();
  if (!/^https:\/\//i.test(url)) { toast('🧩 Paste an https:// .zip download link', 'warn'); return; }
  if (!confirm('Install an extension from this link?\n\nExtensions can read and change data on the sites you visit. Only install packages from authors you trust.')) return;
  const btn = $('store-url-go');
  btn.disabled = true;
  btn.textContent = 'Installing…';
  try {
    const r = await api.ext.installUrl(url);
    if (r && r.ok) {
      toast(`🧩 Installed ${r.name || 'extension'} — reloading tab to apply`, 'ok');
      $('store-url').value = '';
      $('store-url-row').classList.add('hidden');
      if (state.activeTabId) api.tabs.reload(state.activeTabId);
      await loadStore();
    } else {
      toast(`🧩 ${(r && r.error) || 'Install failed'}`, 'warn');
    }
  } catch (err) {
    toast(`🧩 ${errText(err)}`, 'warn');
  }
  btn.disabled = false;
  btn.textContent = 'Install';
};

$('store-url').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('store-url-go').click(); });

async function openStore() {
  $('overlay-store').classList.remove('hidden');
  api.ui.overlay('store'); // hide the page view so the panel is visible
  showStoreTab('browse');
  await loadStore();
  refreshCommunityCatalog();
}

// Cached entries render immediately; this pulls the GitHub-hosted catalog in
// the background and re-renders when it lands. Offline just keeps the cache.
async function refreshCommunityCatalog() {
  $('store-status').textContent += ' · refreshing community…';
  try {
    const r = await api.ext.refresh();
    if (r && r.ok) await loadStore();
    else $('store-status').textContent = `Community catalog unavailable${r && r.error ? ` — ${r.error}` : ''}`;
  } catch (err) {
    $('store-status').textContent = `Community catalog unavailable — ${errText(err)}`;
  }
}

async function loadStore() {
  const grid = $('store-grid');
  grid.innerHTML = '<p class="muted">Loading catalog…</p>';
  let res;
  try { res = await api.ext.list(); } catch (err) {
    grid.innerHTML = '';
    toast(`🧩 ${errText(err)}`, 'warn');
    return;
  }
  grid.innerHTML = '';
  for (const item of res.items) grid.appendChild(storeCard(item));
  if (!res.items.length) grid.innerHTML = '<p class="muted">No extensions yet.</p>';
  const parts = [`${res.count} active`, `${res.bundled || 0} built-in`];
  if (res.community) parts.push(`${res.community} community`);
  $('store-status').textContent = parts.join(' · ');
  const badge = $('store-badge');
  badge.textContent = String(res.count);
  badge.classList.toggle('hidden', res.count === 0);
}

function storeCard(item) {
  const card = document.createElement('div');
  card.className = 'xcard' + (item.installed ? ' on' : '');

  const top = document.createElement('div');
  top.className = 'xcard-top';
  const icon = document.createElement('div');
  icon.className = 'xcard-icon';
  icon.textContent = item.emoji;
  const meta = document.createElement('div');
  meta.className = 'xcard-meta';
  const name = document.createElement('b');
  name.textContent = item.name + (item.version ? ` v${item.version}` : '');
  const tag = document.createElement('span');
  tag.className = 'muted';
  tag.textContent = item.tagline;
  meta.append(name, tag);
  if (item.community) {
    const by = document.createElement('span');
    by.className = 'xcard-author';
    by.textContent = item.author ? `by ${item.author}` : 'Community extension';
    meta.appendChild(by);
  }
  top.append(icon, meta);

  const foot = document.createElement('div');
  foot.className = 'xcard-foot';
  const chip = document.createElement('span');
  chip.className = 'xcard-chip';
  chip.textContent = item.category;
  foot.appendChild(chip);
  if (item.community) {
    const c = document.createElement('span');
    c.className = 'xcard-chip community';
    c.textContent = 'Community';
    foot.appendChild(c);
  }
  if (item.rating) {
    const rate = document.createElement('span');
    rate.className = 'xcard-rating';
    rate.textContent = `★ ${item.rating}`;
    foot.appendChild(rate);
  }
  if (item.users) {
    const users = document.createElement('span');
    users.className = 'muted';
    users.textContent = `${item.users} users`;
    foot.appendChild(users);
  }
  const btn = document.createElement('button');
  btn.className = 'xcard-btn' + (item.installed ? ' remove' : '');
  btn.textContent = item.installed ? 'Remove' : 'Install';
  btn.onclick = async () => {
    btn.disabled = true;
    try {
      if (item.installed) {
        await api.ext.uninstall(item.key);
        toast(`🧩 Removed ${item.name} — reload open tabs to apply`, 'info');
      } else {
        if (item.community) {
          const ok = confirm(`${item.name}${item.author ? ` by ${item.author}` : ''} is a community extension.\n\nExtensions can read and change data on the sites you visit. Install it only if you trust its author. Continue?`);
          if (!ok) { btn.disabled = false; return; }
        }
        await api.ext.install(item.key);
        toast(`🧩 Installed ${item.name}${item.community ? ' (hash-checked)' : ''} — reloading tab to apply`, 'ok');
        // Content scripts run at document_idle, so the current page needs a
        // reload to pick the extension up.
        if (state.activeTabId) api.tabs.reload(state.activeTabId);
      }
    } catch (err) {
      toast(`🧩 ${errText(err)}`, 'warn');
    }
    btn.disabled = false;
    await loadStore();
  };
  foot.appendChild(btn);
  card.append(top, foot);
  return card;
}

// ---- Publish (free GitHub-hosted catalog) --------------------------------
$('pub-pick').onclick = async () => {
  const r = await api.ext.pickFolder();
  if (!r || r.canceled) return;
  if (!r.ok) { $('pub-status').textContent = r.error || 'Could not read that folder.'; return; }
  pubDir = r.dir;
  pubEntry = null;
  pubZip = null;
  pubSubmit = null;
  $('pub-name').value = r.manifest.name;
  $('pub-version').value = r.manifest.version;
  $('pub-desc').value = r.manifest.description || '';
  $('pub-manifest').textContent = `${r.manifest.name} v${r.manifest.version} · manifest v${r.manifest.manifest_version}`;
  $('pub-form').classList.remove('hidden');
  $('pub-result').classList.add('hidden');
  $('pub-status').textContent = '';
};

$('pub-build').onclick = async () => {
  if (!pubDir) return;
  const meta = {
    name: $('pub-name').value.trim(),
    version: $('pub-version').value.trim(),
    author: $('pub-author').value.trim(),
    category: $('pub-category').value,
    emoji: $('pub-emoji').value.trim() || '🧩',
    homepage: $('pub-home').value.trim(),
    downloadUrl: $('pub-url').value.trim(),
    description: $('pub-desc').value.trim(),
  };
  const btn = $('pub-build');
  btn.disabled = true;
  btn.textContent = 'Packaging…';
  try {
    const r = await api.ext.publish({ dir: pubDir, meta });
    if (r && r.ok) {
      pubEntry = r.entry;
      pubZip = r.zipPath;
      pubSubmit = r.submitUrl;
      $('pub-json').textContent = JSON.stringify(r.entry, null, 2);
      $('pub-result').classList.remove('hidden');
      $('pub-status').textContent = `Saved ${r.zipPath} · SHA-256 ${r.sha256.slice(0, 16)}…`;
      toast('🧩 Package built — submit it on GitHub for free', 'ok');
    } else if (r && !r.canceled) {
      $('pub-status').textContent = r.error || 'Packaging failed.';
    }
  } catch (err) {
    $('pub-status').textContent = errText(err);
  }
  btn.disabled = false;
  btn.textContent = '📦 Build .zip + submission';
};

$('pub-copy').onclick = async () => {
  if (!pubEntry) return;
  const text = JSON.stringify(pubEntry, null, 2);
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  toast('📋 Catalog JSON copied', 'ok');
};

$('pub-issue').onclick = () => {
  if (pubSubmit) api.openExternal(pubSubmit);
};

$('pub-reveal').onclick = () => {
  if (pubZip) api.ext.reveal(pubZip);
};

async function loadSettings() {
  const s = await api.settings.get();
  state.settings = s;
  $('set-clean').value = String(s.autoCleanMinutes ?? 10);
  $('set-lock').value = String(s.lockMinutes ?? 15);
  $('set-ads').checked = s.blockAds !== false;
  $('set-fp').checked = s.antiFingerprint !== false;
  $('set-ref').checked = s.strictReferrer !== false;
  $('set-ai-url').value = s.aiBaseUrl || '';
  $('set-ai-model').value = s.aiModel || '';
  $('ai-config-status').textContent = s.aiMode === 'cloud'
    ? `Connected (${s.aiModel}). API key stored encrypted in your vault.`
    : 'Using built-in local AI (no data leaves your machine). Add an API key for cloud AI.';
  $('stat-ai') && ($('stat-ai').textContent = s.aiMode === 'cloud' ? 'cloud' : 'local');

  // Account — the username is a sign-in label, never part of the vault key.
  try {
    const acct = await api.auth.status();
    state.account = acct;
    $('set-username').value = acct.username || '';
    $('username-status').textContent = acct.hasUsername
      ? `Signed in as ${acct.username}. Changing it only changes the sign-in label — your encrypted history stays readable.`
      : 'No username set yet — add one to show it on the sign-in screen.';
  } catch { /* main busy */ }

  // Search engine + anonymity
  renderSearchSettings(s);
  $('set-anon').value = s.anonymity || 'direct';
  $('set-proxy-scheme').value = s.proxyScheme || 'socks5';
  $('set-proxy-host').value = s.proxyHost || '127.0.0.1';
  $('set-proxy-port').value = String(s.proxyPort || 9150);
  $('proxy-custom').classList.toggle('hidden', (s.anonymity || 'direct') !== 'custom');
  $('set-cookies').checked = s.strictCookies !== false;
  $('set-english').checked = s.forceEnglish !== false;
  $('set-trusted').value = (s.trustedSites || []).join(', ');
  syncEngineUi(); // omnibox engine pill + new-tab line follow settings
  await updateNetStatus();
}

// Live anonymity-route status shown in Settings and the status bar.
async function updateNetStatus() {
  try {
    const n = await api.net.status();
    const label = n.mode === 'tor' ? 'Tor' : n.mode === 'custom' ? `Proxy ${n.rules}` : 'Direct';
    let text = `Status: ${label}`;
    if (n.mode !== 'direct') {
      text += n.reachable === true ? ' · ✅ reachable'
        : n.reachable === false ? ' · ❌ NOT reachable — traffic cannot load' : '';
    } else {
      text += ' · sites see your real IP — enable Tor/proxy for full anonymity';
    }
    $('net-status').textContent = text;
    $('status-net').textContent = `🌐 ${label}${n.mode !== 'direct' ? (n.reachable ? '' : ' ⚠️') : ''}`;
  } catch { /* main busy */ }
}

$('net-test').onclick = async () => {
  $('net-status').textContent = 'Status: testing…';
  await updateNetStatus();
};

// ---------------- quick search-engine switcher (omnibox pill, Firefox-style) ----------------
// One click from anywhere: shows the engines the user kept enabled, with a ✓ on
// the current one, switches instantly, and stays in sync with Settings.
function enabledEngineList(s) {
  const engines = (s && s.engines) || {};
  const wanted = Array.isArray(s && s.enabledEngines)
    ? s.enabledEngines
    : Object.keys(engines);
  const current = (s && s.searchEngine) || 'aegis';
  const list = Object.keys(engines).filter((k) => wanted.includes(k) || k === current);
  return list.length ? list : ['aegis'];
}

function syncEngineUi() {
  const s = state.settings || {};
  const engines = s.engines || {};
  const current = s.searchEngine || 'aegis';
  const cur = engines[current] || { label: 'Aegis AI', short: 'Aegis AI', icon: '🛡️' };
  $('engine-btn').textContent = `${cur.icon || '🔍'} ${cur.short || cur.label} ▾`;
  const ntName = $('nt-engine-name');
  if (ntName) ntName.textContent = cur.short || cur.label;

  const menu = $('engine-menu');
  menu.innerHTML = '';

  const head = document.createElement('div');
  head.className = 'engine-menu-head';
  head.textContent = 'Search with';
  menu.appendChild(head);

  // Engine list scrolls on its own so the Add / Manage actions below stay put.
  const list = document.createElement('div');
  list.className = 'engine-list';
  for (const key of enabledEngineList(s)) {
    const eng = engines[key];
    if (!eng) continue;
    const item = document.createElement('button');
    item.className = 'engine-item' + (key === current ? ' current' : '');
    const tick = document.createElement('span');
    tick.className = 'tick';
    tick.textContent = key === current ? '✓' : '';
    const icon = document.createElement('span');
    icon.className = 'engine-icon';
    icon.textContent = eng.icon || '🔎';
    const name = document.createElement('span');
    name.className = 'engine-item-name';
    name.textContent = eng.short || eng.label;
    item.append(tick, icon, name);
    item.onclick = async () => {
      await api.settings.set({ searchEngine: key });
      state.settings = { ...state.settings, searchEngine: key };
      closeEngineMenu();
      syncEngineUi();
      toast(`🔍 Searching with ${eng.label}`, 'ok');
    };
    list.appendChild(item);
  }
  menu.appendChild(list);

  const foot = document.createElement('div');
  foot.className = 'engine-foot';

  const add = document.createElement('button');
  add.className = 'engine-item engine-more';
  add.textContent = '➕ Add search engine…';
  add.onclick = () => { closeEngineMenu(); openSettings('search'); };
  foot.appendChild(add);

  const more = document.createElement('button');
  more.className = 'engine-item engine-more';
  more.textContent = '⚙️ Manage search engines…';
  more.onclick = () => { closeEngineMenu(); openSettings('search'); };
  foot.appendChild(more);

  menu.appendChild(foot);
}

$('engine-btn').onclick = (e) => {
  e.stopPropagation();
  if ($('engine-menu').classList.contains('hidden')) openEngineMenu();
  else closeEngineMenu();
};
// Click anywhere outside the omnibox closes the menu.
document.addEventListener('click', (e) => {
  const wrap = $('omnibox-wrap');
  if (wrap && !wrap.contains(e.target)) closeEngineMenu();
});
// The new-tab "Searching with …" line is a second, very visible switch entry.
$('nt-engine').onclick = () => {
  openEngineMenu();
  $('engine-btn').focus();
};

// The native page view paints above the chrome DOM, so the dropdown would be
// invisible on a real page. Hiding the view while the menu is open makes the
// options actually clickable (on the new-tab hero the view is hidden anyway).
function openEngineMenu() {
  syncEngineUi();
  $('engine-menu').classList.remove('hidden');
  api.ui.overlay('engine-menu');
}

function closeEngineMenu() {
  const menu = $('engine-menu');
  if (menu.classList.contains('hidden')) return;
  menu.classList.add('hidden');
  const modalOpen = !$('overlay-settings').classList.contains('hidden')
    || !$('overlay-store').classList.contains('hidden');
  if (!modalOpen) api.ui.overlay(null);
}

async function openSettings(section) {
  try { await loadSettings(); } catch (err) { console.error('settings load failed', err); }
  $('overlay-settings').classList.remove('hidden');
  api.ui.overlay('settings'); // hide the page view so the panel is visible
  if (section) {
    const target = $(`set-group-${section}`);
    if (target) setTimeout(() => target.scrollIntoView({ block: 'start', behavior: 'smooth' }), 40);
  }
}

$('set-clean').onchange = async (e) => {
  await api.settings.set({ autoCleanMinutes: Number(e.target.value) });
  toast('🧹 Auto-clean schedule updated', 'ok');
  refreshPrivacyStats();
};
$('set-lock').onchange = (e) => api.settings.set({ lockMinutes: Number(e.target.value) });
$('set-ads').onchange = (e) => api.settings.set({ blockAds: e.target.checked });
$('set-fp').onchange = (e) => api.settings.set({ antiFingerprint: e.target.checked });
$('set-ref').onchange = (e) => api.settings.set({ strictReferrer: e.target.checked });

// Search engine customization (Settings → Search). Everything is validated in
// main; the renderer only collects intent and re-renders from fresh settings.
const SOURCE_META = [
  ['web', '🌐', 'Web results', 'DuckDuckGo index — the backbone'],
  ['knowledge', '📚', 'Knowledge', 'Wikipedia + instant facts'],
  ['code', '💻', 'Code & repos', 'Stack Overflow + GitHub'],
  ['papers', '📄', 'Research papers', 'arXiv preprints'],
  ['discussions', '💬', 'Discussions', 'Hacker News'],
];
const CANON_BANGS = [
  ['g', 'google'], ['b', 'bing'], ['ddg', 'ddg'], ['sp', 'startpage'],
  ['brave', 'brave'], ['yt', 'youtube'], ['w', 'wikipedia'], ['a', 'aegis'],
];

function renderSearchSettings(s) {
  renderEngineCards(s);
  renderEngineToggles(s);
  renderCustomEngines(s);
  renderSourceToggles(s);
  renderBangChips(s);
}

async function refreshSearchSettings() {
  const s = await api.settings.get();
  state.settings = s;
  renderSearchSettings(s);
  syncEngineUi();
  return s;
}

function renderEngineCards(s) {
  const wrap = $('engine-cards');
  wrap.innerHTML = '';
  const engines = s.engines || {};
  const current = s.searchEngine || 'aegis';
  for (const [key, eng] of Object.entries(engines)) {
    const card = document.createElement('button');
    card.className = 'engine-card' + (key === current ? ' active' : '');
    card.dataset.engine = key;
    card.title = `Set ${eng.label} as the default search engine`;
    const icon = document.createElement('span');
    icon.className = 'engine-icon';
    icon.textContent = eng.icon || '🔎';
    const name = document.createElement('span');
    name.className = 'engine-name';
    name.textContent = eng.short || eng.label;
    const mark = document.createElement('span');
    mark.className = 'engine-mark';
    mark.textContent = key === current ? '✓' : '';
    card.append(icon, name, mark);
    card.onclick = async () => {
      await api.settings.set({ searchEngine: key });
      await refreshSearchSettings();
      toast(`🔍 Searching with ${eng.label}`, 'ok');
    };
    wrap.appendChild(card);
  }
}

function renderEngineToggles(s) {
  const wrap = $('engine-toggles');
  wrap.innerHTML = '';
  const engines = s.engines || {};
  const enabled = Array.isArray(s.enabledEngines) ? s.enabledEngines : Object.keys(engines);
  const current = s.searchEngine || 'aegis';
  for (const [key, eng] of Object.entries(engines)) {
    const chip = document.createElement('label');
    chip.className = 'engine-toggle' + (enabled.includes(key) ? ' on' : '');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = enabled.includes(key);
    cb.disabled = key === current; // the active default always stays visible
    cb.dataset.engine = key;
    cb.onchange = async () => {
      const next = enabled.filter((k) => k !== key);
      if (cb.checked) next.push(key);
      await api.settings.set({ enabledEngines: next });
      await refreshSearchSettings();
    };
    const text = document.createElement('span');
    text.textContent = `${eng.icon || '🔎'} ${eng.short || eng.label}`;
    chip.append(cb, text);
    if (key === current) chip.title = 'Current default — always shown in the switcher';
    wrap.appendChild(chip);
  }
}

function renderCustomEngines(s) {
  const wrap = $('eng-custom-list');
  wrap.innerHTML = '';
  const customs = Array.isArray(s.customEngines) ? s.customEngines : [];
  if (!customs.length) {
    const p = document.createElement('p');
    p.className = 'muted';
    p.textContent = 'No custom engines yet — add one above and it appears in the 🔍 switcher.';
    wrap.appendChild(p);
    return;
  }
  for (const ce of customs) {
    const row = document.createElement('div');
    row.className = 'eng-row';
    const name = document.createElement('div');
    name.className = 'eng-row-name';
    name.textContent = `🔎 ${ce.label}`;
    const meta = document.createElement('div');
    meta.className = 'eng-row-url';
    meta.textContent = ce.url + (ce.bang ? `  ·  !${ce.bang}` : '');
    name.appendChild(meta);
    const del = document.createElement('button');
    del.className = 'h-del';
    del.title = 'Remove this engine';
    del.textContent = '✕';
    del.onclick = async () => {
      await api.settings.set({ customEngines: customs.filter((x) => x.key !== ce.key) });
      await refreshSearchSettings();
      toast(`🔎 Removed ${ce.label}`, 'info');
    };
    row.append(name, del);
    wrap.appendChild(row);
  }
}

function renderSourceToggles(s) {
  const wrap = $('source-toggles');
  wrap.innerHTML = '';
  const src = s.searchSources || {};
  for (const [key, icon, label, hint] of SOURCE_META) {
    const chip = document.createElement('label');
    chip.className = 'engine-toggle' + (src[key] !== false ? ' on' : '');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = src[key] !== false;
    cb.dataset.source = key;
    cb.onchange = async () => {
      const next = { ...src, [key]: cb.checked };
      await api.settings.set({ searchSources: next });
      await refreshSearchSettings();
    };
    const text = document.createElement('span');
    text.textContent = `${icon} ${label}`;
    text.title = hint;
    chip.append(cb, text);
    wrap.appendChild(chip);
  }
}

function renderBangChips(s) {
  const wrap = $('bang-chips');
  wrap.innerHTML = '';
  const engines = s.engines || {};
  const enabled = Array.isArray(s.enabledEngines) ? s.enabledEngines : Object.keys(engines);
  const chips = [];
  for (const [token, key] of CANON_BANGS) {
    if (enabled.includes(key) && engines[key]) chips.push([token, engines[key]]);
  }
  // Custom engines bring their own bang if the user set one.
  for (const eng of Object.values(engines)) {
    if (eng.custom && eng.bang) chips.push([eng.bang, eng]);
  }
  if (!chips.length) {
    const p = document.createElement('p');
    p.className = 'muted';
    p.textContent = 'Type "!a query" to force Aegis, or enable engines above.';
    wrap.appendChild(p);
    return;
  }
  for (const [token, eng] of chips) {
    const chip = document.createElement('button');
    chip.className = 'bang-chip';
    chip.textContent = `!${token}`;
    chip.title = `Search ${eng.label} once (e.g. "!${token} your query")`;
    chip.onclick = () => {
      const box = $('omnibox');
      box.value = `!${token} `;
      closeOverlay('settings');
      box.focus();
    };
    const label = document.createElement('span');
    label.className = 'bang-label';
    label.textContent = eng.label;
    const group = document.createElement('span');
    group.className = 'bang-group';
    group.append(chip, label);
    wrap.appendChild(group);
  }
}

// ---- add-engine form -------------------------------------------------------
$('eng-add-btn').onclick = async () => {
  const status = $('eng-add-status');
  const label = $('eng-name').value.trim();
  const url = $('eng-url').value.trim();
  const bang = $('eng-bang').value.trim();
  status.textContent = '';

  if (!label) { status.textContent = 'Give the engine a name first.'; return; }
  if (!/%s|\{q\}/.test(url)) {
    status.textContent = 'The URL needs %s where the query goes — e.g. https://www.ecosia.org/search?q=%s';
    return;
  }
  const before = (state.settings.customEngines || []).length;
  const r = await api.settings.set({
    customEngines: [...(state.settings.customEngines || []), { label, url, bang }],
  });
  const after = (r.settings.customEngines || []).length;
  if (after === before) {
    status.textContent = 'That URL was rejected — it must be a normal http(s) address containing %s.';
    return;
  }
  $('eng-name').value = '';
  $('eng-url').value = '';
  $('eng-bang').value = '';
  status.textContent = `Added ${label} — it is now in the 🔍 switcher.`;
  await refreshSearchSettings();
  toast(`🔎 Added ${label}`, 'ok');
};
$('set-anon').onchange = async (e) => {
  await api.settings.set({ anonymity: e.target.value });
  $('proxy-custom').classList.toggle('hidden', e.target.value !== 'custom');
  await updateNetStatus();
  toast(e.target.value === 'direct'
    ? '🌐 Direct mode — sites see your real IP'
    : '🕶️ Anonymity network enabled', e.target.value === 'direct' ? 'warn' : 'ok');
};
const saveProxy = () => api.settings.set({
  proxyScheme: $('set-proxy-scheme').value,
  proxyHost: $('set-proxy-host').value.trim(),
  proxyPort: Number($('set-proxy-port').value) || 0,
}).then(updateNetStatus);
$('set-proxy-scheme').onchange = saveProxy;
$('set-proxy-host').onchange = saveProxy;
$('set-proxy-port').onchange = saveProxy;
$('set-cookies').onchange = (e) => api.settings.set({ strictCookies: e.target.checked });
$('set-english').onchange = (e) => api.settings.set({ forceEnglish: e.target.checked });
$('set-trusted').onchange = async (e) => {
  const sites = e.target.value.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean);
  await api.settings.set({ trustedSites: sites });
  toast(`🤝 ${sites.length} trusted site(s) will keep you signed in`, 'ok');
};

$('settings-save-ai').onclick = async () => {
  const patch = { aiBaseUrl: $('set-ai-url').value.trim(), aiModel: $('set-ai-model').value.trim() };
  await api.settings.set(patch);
  const key = $('set-ai-key').value.trim();
  if (key) {
    await api.settings.setSecrets({ aiApiKey: key, ...patch });
    $('set-ai-key').value = '';
  }
  await loadSettings();
  toast('✨ AI config saved (encrypted)', 'ok');
};

$('settings-clean-now').onclick = () => $('btn-clean').click();
$('settings-lock').onclick = () => $('btn-lock').click();

$('set-username-save').onclick = async () => {
  try {
    const r = await api.auth.setUsername($('set-username').value.trim());
    state.account = { ...(state.account || {}), username: r.username, hasUsername: true };
    $('username-status').textContent = `Saved — you will sign in as ${r.username}.`;
    toast('👤 Username updated', 'ok');
  } catch (e) {
    $('username-status').textContent = errText(e);
  }
};
$('set-username').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('set-username-save').click(); });
$('settings-wipe').onclick = async () => {
  if (!confirm('Erase ALL Aegis data and reset? This cannot be undone.')) return;
  await api.auth.wipe();
  location.reload();
};

// ---------------- privacy stats + notifications ----------------
async function refreshPrivacyStats() {
  const s = await api.privacy.status();
  $('stat-blocked').textContent = s.stats.total;
  $('status-left').textContent = `🛡️ ${s.stats.total} blocked (${s.stats.ads} ads · ${s.stats.trackers} trackers)`;
  $('stat-lastclean').textContent = s.lastClean ? fmtTime(s.lastClean) : '—';
  $('status-mid').textContent = s.autoCleanMinutes
    ? `🧹 auto-clean every ${s.autoCleanMinutes}m`
    : '🧹 auto-clean off';
  const t = state.tabs.find((x) => x.id === state.activeTabId);
  $('omnibox-badge').textContent = t && t.url && t.url.startsWith('https') ? '🔒' : '🛡️';
}
setInterval(refreshPrivacyStats, 4000);

api.privacy.onCleaned((info) => {
  toast(`🧹 ${info.reason === 'interval' ? 'Auto-clean' : 'Clean'}: ${info.cookies} cookies removed, cache flushed`, 'ok');
  refreshPrivacyStats();
});
api.ui.onNotify((n) => toast(`${n.title}: ${n.body}`, 'warn'));

// Reset idle timer on any interaction
for (const ev of ['mousemove', 'keydown', 'click', 'wheel']) {
  window.addEventListener(ev, () => api.activity(), { passive: true });
}

boot();
