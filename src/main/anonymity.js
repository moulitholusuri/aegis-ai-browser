'use strict';
// Anonymity helpers: tracker-param stripping, search-engine routing with
// bangs, browser UA normalization, and proxy reachability testing.
// Kept Electron-free so it can be unit-tested with plain node.

const net = require('net');
const os = require('os');

// A Chrome-identical UA. Electron's default UA contains "Electron/x.y",
// which sites (Google, Microsoft 365, banks…) use to block or profile us.
function chromeUA() {
  const platform =
    process.platform === 'darwin' ? 'Macintosh; Intel Mac OS X 10_15_7' :
    process.platform === 'win32' ? (os.arch() === 'x64' ? 'Windows NT 10.0; Win64; x64' : 'Windows NT 10.0; WOW64') :
    'X11; Linux x86_64';
  return `Mozilla/5.0 (${platform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36`;
}

// Exact-name and prefix tracking parameters removed from every navigated URL.
const TRACKING_PARAMS = new Set([
  'fbclid', 'gclid', 'dclid', 'gad_source', 'gad_campaignid', 'gbraid', 'wbraid',
  'msclkid', 'yclid', 'igshid', 'mc_cid', 'mc_eid', 'mkt_tok', 'trk', 'trkcampaign',
  'vero_id', 'vero_conv', 'wickedid', 'oly_anon_id', 'oly_enc_id', 'rb_clickid',
  's_cid', 'campaign_id', 'srsltid', 'ttclid', 'twclid', 'li_fat_id', 'ppcau',
  'dcopt', 'ef_id', '_hsenc', '_hsmi', '__hssc', '__hstc', 'hsctracking',
  'ref_src', 'ref_url', 'si', 'feature', 'share_id', 'cmpid', 'ncid', 'ocid',
  '_openstat', 's_kwcid', 'pk_kwd', 'piwik_campaign', 'matomo_campaign',
]);
const TRACKING_PREFIXES = ['utm_', 'hsa_', 'pk_', 'piwik_', 'matomo_', 'itm_', 'mtm_', 'vero_'];

// Remove tracking parameters from a URL. Idempotent; non-http(s) untouched.
function stripTrackingParams(rawUrl) {
  let u;
  try { u = new URL(rawUrl); } catch { return rawUrl; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return rawUrl;
  let changed = false;
  for (const key of [...u.searchParams.keys()]) {
    const lk = key.toLowerCase();
    if (TRACKING_PARAMS.has(lk) || TRACKING_PREFIXES.some((p) => lk.startsWith(p))) {
      u.searchParams.delete(key);
      changed = true;
    }
  }
  if (u.hash && /utm_|fbclid|gclid/i.test(u.hash)) { u.hash = ''; changed = true; }
  return changed ? u.toString() : rawUrl;
}

// Search engines the omnibox can use, like Firefox's engine list.
const ENGINES = {
  aegis: { label: 'Aegis AI (metasearch)', url: (q) => `aegis://search?q=${encodeURIComponent(q)}` },
  google: { label: 'Google', url: (q) => `https://www.google.com/search?q=${encodeURIComponent(q)}` },
  bing: { label: 'Bing', url: (q) => `https://www.bing.com/search?q=${encodeURIComponent(q)}` },
  ddg: { label: 'DuckDuckGo', url: (q) => `https://duckduckgo.com/?q=${encodeURIComponent(q)}` },
  startpage: { label: 'Startpage', url: (q) => `https://www.startpage.com/sp/search?query=${encodeURIComponent(q)}` },
  brave: { label: 'Brave Search', url: (q) => `https://search.brave.com/search?q=${encodeURIComponent(q)}` },
  youtube: { label: 'YouTube', url: (q) => `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}` },
};
ENGINES.wikipedia = { label: 'Wikipedia', url: (q) => `https://en.wikipedia.org/w/index.php?search=${encodeURIComponent(q)}` };

// Icons for the omnibox pill, quick-switcher menu and Settings cards.
const ENGINE_ICONS = {
  aegis: '🛡️', google: '🔵', bing: '🟦', ddg: '🦆', startpage: '🕵️',
  brave: '🦁', youtube: '▶️', wikipedia: '📚',
};
const CUSTOM_ENGINE_ICON = '🔎';

// Engines shown in the quick switcher by default.
const DEFAULT_ENABLED_ENGINES = Object.keys(ENGINES);

function engineIcon(key) {
  return ENGINE_ICONS[key] || CUSTOM_ENGINE_ICON;
}

// Fine — a search URL template must be http(s) and contain a %s (or {q})
// placeholder where the encoded query goes. Bare hosts get https://.
function normalizeEngineUrl(raw) {
  let tpl = String(raw || '').trim();
  if (!tpl) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(tpl)) tpl = `https://${tpl}`;
  if (!/%s|\{q\}/.test(tpl)) return null;
  try {
    const parsed = new URL(tpl.replace(/%s|\{q\}/g, 'test'));
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  } catch {
    return null;
  }
  return tpl;
}

function fillTemplate(tpl, query) {
  return String(tpl).replace(/%s|\{q\}/g, encodeURIComponent(String(query || '').trim()));
}

// Per-query bang shortcuts: !g google, !b/!bing, !ddg, !sp, !brave, !yt, !w,
// plus !a to force Aegis no matter the default engine.
const BANGS = {
  g: 'google', google: 'google',
  b: 'bing', bing: 'bing',
  ddg: 'ddg',
  sp: 'startpage', startpage: 'startpage',
  brave: 'brave',
  yt: 'youtube', youtube: 'youtube',
  a: 'aegis', aegis: 'aegis',
  w: 'wikipedia', wiki: 'wikipedia',
};

// Sanitize the user's custom engines: label ≤ 40 chars, http(s) template with
// %s, optional unique bang, stable c1/c2/... keys, max 20 entries.
function normalizeCustomEngines(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  const usedKeys = new Set();
  const usedBangs = new Set(Object.keys(BANGS));
  let seq = 0;
  for (const raw of list.slice(0, 20)) {
    if (!raw || typeof raw !== 'object') continue;
    const label = String(raw.label || '').trim().replace(/\s+/g, ' ').slice(0, 40);
    const url = normalizeEngineUrl(raw.url);
    if (!label || !url) continue;

    let key = /^c\d+$/.test(String(raw.key || '')) ? String(raw.key) : null;
    if (!key || usedKeys.has(key)) {
      do { seq += 1; key = `c${seq}`; } while (usedKeys.has(key));
    }
    usedKeys.add(key);

    let bang = String(raw.bang || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 6);
    if (!bang || usedBangs.has(bang)) bang = '';
    if (bang) usedBangs.add(bang);

    out.push({ key, label, url, bang });
  }
  return out;
}

// Full engine list for the UI: built-ins + the user's custom engines.
// Plain data only (no functions) so it survives structured-clone IPC.
function engineMap(settings) {
  const map = {};
  for (const [key, eng] of Object.entries(ENGINES)) {
    map[key] = {
      key,
      label: eng.label,
      short: key === 'aegis' ? 'Aegis AI' : eng.label,
      icon: engineIcon(key),
      custom: false,
      bang: '',
    };
  }
  for (const ce of normalizeCustomEngines(settings && settings.customEngines)) {
    map[ce.key] = {
      key: ce.key, label: ce.label, short: ce.label, icon: CUSTOM_ENGINE_ICON, custom: true,
      url: ce.url, bang: ce.bang,
    };
  }
  return map;
}

// Resolve an engine key (built-in or custom) to something with .url(query).
function resolveEngine(engine, settings) {
  const custom = normalizeCustomEngines(settings && settings.customEngines)
    .find((e) => e.key === engine);
  if (custom) return { label: custom.label, url: (q) => fillTemplate(custom.url, q) };
  if (ENGINES[engine]) return ENGINES[engine];
  return null;
}

function parseBang(input, settings) {
  const m = String(input || '').trim().match(/^!(\w+)\s+(.+)$/);
  if (!m) return null;
  const token = m[1].toLowerCase();
  if (BANGS[token] && ENGINES[BANGS[token]]) return { engine: BANGS[token], query: m[2].trim() };
  const custom = normalizeCustomEngines(settings && settings.customEngines)
    .find((e) => e.bang === token);
  if (custom) return { engine: custom.key, query: m[2].trim() };
  return null;
}

// Resolve omnibox text to the final URL for a search request.
// `settings` (optional) enables custom engines and their bangs.
function buildSearchUrl(engine, input, settings) {
  const bang = parseBang(input, settings);
  if (bang) {
    const r = resolveEngine(bang.engine, settings);
    if (r) return r.url(bang.query);
  }
  const resolved = resolveEngine(engine, settings) || ENGINES.aegis;
  return resolved.url(String(input).trim());
}

// TCP reachability check (used to verify a Tor/proxy port is actually live).
// Merge a settings patch, validating everything search-related in one pure
// place (unit-tested; main.js stays thin). Handles custom-engine keys,
// auto-enabling new engines, pruning removed ones, and engine fallbacks.
function applySearchSettings(current, patch) {
  const base = current || {};
  const safe = { ...(patch || {}) };
  const prevCustomKeys = new Set(
    normalizeCustomEngines(base.customEngines).map((e) => e.key),
  );

  if ('customEngines' in safe) safe.customEngines = normalizeCustomEngines(safe.customEngines);
  if ('enabledEngines' in safe) {
    const known = Object.keys(engineMap({ ...base, ...safe }));
    const wanted = Array.isArray(safe.enabledEngines) ? safe.enabledEngines.map(String) : [];
    const list = [...new Set(wanted)].filter((k) => known.includes(k));
    safe.enabledEngines = list.length ? list : ['aegis'];
  }
  if ('searchSources' in safe) {
    const groups = ['web', 'knowledge', 'code', 'papers', 'discussions'];
    const src = safe.searchSources && typeof safe.searchSources === 'object' ? safe.searchSources : {};
    const clean = Object.fromEntries(groups.map((g) => [g, src[g] !== false]));
    if (!groups.some((g) => clean[g])) clean.web = true; // never leave Aegis with nothing
    safe.searchSources = clean;
  }

  const next = { ...base, ...safe };

  // A newly added custom engine shows up in the switcher immediately.
  const addedKeys = (Array.isArray(next.customEngines) ? next.customEngines : [])
    .map((e) => e.key)
    .filter((k) => !prevCustomKeys.has(k));
  if (addedKeys.length) {
    next.enabledEngines = [...new Set([...(next.enabledEngines || []), ...addedKeys])];
  }

  // Drop engines that no longer exist; keep the active default visible.
  const knownNow = engineMap(next);
  if (Array.isArray(next.enabledEngines)) {
    next.enabledEngines = next.enabledEngines.filter((k) => knownNow[k]);
    if (!next.enabledEngines.length) next.enabledEngines = ['aegis'];
  }
  if (!knownNow[next.searchEngine]) next.searchEngine = 'aegis';
  if (Array.isArray(next.enabledEngines) && !next.enabledEngines.includes(next.searchEngine)) {
    next.enabledEngines = [...next.enabledEngines, next.searchEngine];
  }
  return next;
}

function testTcp(host, port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port: Number(port) });
    const done = (ok) => { socket.destroy(); resolve(ok); };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

module.exports = {
  chromeUA, stripTrackingParams, testTcp,
  ENGINES, BANGS, DEFAULT_ENABLED_ENGINES, CUSTOM_ENGINE_ICON,
  engineIcon, engineMap, normalizeEngineUrl, normalizeCustomEngines,
  resolveEngine, parseBang, buildSearchUrl, fillTemplate, applySearchSettings,
};
