'use strict';
// Aegis Extension Store — real MV3 extensions running in the browse partition,
// plus a FREE community catalog hosted on GitHub (store/index.json in the repo).
//
// Publishing costs nothing: the Publish tab packages the extension into a .zip,
// computes its SHA-256, builds the catalog entry and opens a prefilled GitHub
// submission. Anyone can host the .zip on GitHub Releases (free) and open a PR
// against the catalog — no developer account, no store fee, no backend server.
//
// Electron does not persist loaded extensions across restarts, so the installed
// set is stored in settings and re-loaded on every launch. Electron also assigns
// its own extension ids (not folder names), so we persist a key -> id map.

const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const AdmZip = require('adm-zip');

const EXTENSIONS_DIR = path.join(__dirname, '..', '..', 'extensions');
const STORE_INDEX_URL = 'https://raw.githubusercontent.com/moulitholusuri/aegis-ai-browser/main/store/index.json';
const MAX_ZIP_BYTES = 30 * 1024 * 1024;
const MAX_UNPACKED_BYTES = 60 * 1024 * 1024;

// Store metadata for the bundled catalog. Names/descriptions come from each
// extension's manifest.json at runtime; these are the store-facing extras.
const CATALOG = [
  {
    id: 'night-lens',
    emoji: '🌙',
    tagline: 'Dark mode for every site — dims bright pages, keeps images correct.',
    category: 'Appearance',
    rating: 4.7,
    users: '48.2k',
  },
  {
    id: 'json-viewer',
    emoji: '🧾',
    tagline: 'Pretty-prints and color-codes JSON responses right in the tab.',
    category: 'Developer tools',
    rating: 4.8,
    users: '31.5k',
  },
  {
    id: 'focus-reader',
    emoji: '🎯',
    tagline: 'Hides sidebars, comments and popups — articles become clean reading.',
    category: 'Productivity',
    rating: 4.6,
    users: '22.1k',
  },
  {
    id: 'cookie-hider',
    emoji: '🍪',
    tagline: 'Hides consent banners WITHOUT clicking accept. Purely cosmetic.',
    category: 'Privacy',
    rating: 4.9,
    users: '67.4k',
  },
  {
    id: 'link-scrubber',
    emoji: '🧹',
    tagline: 'Strips utm_*, fbclid, gclid and 30+ trackers from every link you see or copy.',
    category: 'Privacy',
    rating: 4.8,
    users: '54.9k',
  },
];

function readManifest(dir) {
  try {
    const mf = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
    if (!mf || !mf.manifest_version || !mf.name) return null;
    return mf;
  } catch {
    return null;
  }
}

// Stable, filesystem-safe catalog/package id.
function safeId(value) {
  const s = String(value == null ? '' : value)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[._-]+|[._-]+$/g, '')
    .slice(0, 60);
  return s || 'extension';
}

// Validate + normalize a community catalog (anything can be fetched from the
// network, so nothing reaches the UI or the loader unvalidated).
function normalizeCatalog(raw) {
  const list = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.extensions) ? raw.extensions : []);
  const out = [];
  const seen = new Set();
  for (const e of list) {
    if (!e || typeof e !== 'object') continue;
    const id = safeId(e.id || e.name);
    const name = String(e.name || '').trim();
    const downloadUrl = String(e.downloadUrl || '').trim();
    if (!name || !/^https:\/\/\S+$/i.test(downloadUrl) || seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      name: name.slice(0, 80),
      version: String(e.version || '').trim().slice(0, 32),
      description: String(e.description || '').trim().slice(0, 280),
      author: String(e.author || '').trim().slice(0, 80),
      category: String(e.category || 'Community').trim().slice(0, 40),
      emoji: String(e.emoji || '🧩').trim().slice(0, 8),
      homepage: /^https:\/\/\S+$/i.test(String(e.homepage || '')) ? String(e.homepage).trim() : '',
      downloadUrl,
      sha256: /^[a-f0-9]{64}$/i.test(String(e.sha256 || '')) ? String(e.sha256).toLowerCase() : '',
      updated: String(e.updated || '').trim().slice(0, 32),
    });
  }
  return out;
}

// Extract a zip into `dest`, refusing absolute paths and ".." traversal.
function extractZipBuffer(buf, dest) {
  const zip = new AdmZip(buf);
  const entries = zip.getEntries();
  if (entries.length > 5000) throw new Error('The package contains too many files.');
  let total = 0;
  for (const ent of entries) {
    const name = ent.entryName.replace(/\\/g, '/');
    if (name.startsWith('/') || name.split('/').includes('..')) {
      throw new Error('The package contains an unsafe path.');
    }
    if (ent.isDirectory) continue;
    total += ent.header.size;
    if (total > MAX_UNPACKED_BYTES) throw new Error('The unpacked package is too large.');
    const out = path.join(dest, name);
    if (!out.startsWith(dest + path.sep)) throw new Error('The package contains an unsafe path.');
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, ent.getData());
  }
}

// Most extension zips wrap everything in one top-level folder.
function findManifestRoot(dir) {
  if (fs.existsSync(path.join(dir, 'manifest.json'))) return dir;
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
  const dirs = entries.filter((e) => e.isDirectory() && !e.name.startsWith('.'));
  if (dirs.length === 1) {
    const sub = path.join(dir, dirs[0].name);
    if (fs.existsSync(path.join(sub, 'manifest.json'))) return sub;
  }
  return null;
}

// Free publishing: a prefilled GitHub issue with everything a maintainer needs
// to add the entry to store/index.json. No paid developer account anywhere.
function buildSubmissionUrl(entry) {
  const body = [
    '### Extension submission',
    '',
    `**Name:** ${entry.name}`,
    `**Version:** ${entry.version}`,
    `**Author:** ${entry.author || '—'}`,
    `**Category:** ${entry.category || 'Community'}`,
    `**Homepage:** ${entry.homepage || '—'}`,
    `**Download URL:** ${entry.downloadUrl || '_(attach the .zip below, then host it and paste the public link)_'}`,
    `**SHA-256:** \`${entry.sha256}\``,
    '',
    '**Description**',
    entry.description || '—',
    '',
    '<details><summary>Catalog entry — paste into store/index.json</summary>',
    '',
    '```json',
    JSON.stringify(entry, null, 2),
    '```',
    '</details>',
    '',
    '_Submitted from the Aegis extension store. Publishing is free._',
  ].join('\n');
  return `https://github.com/moulitholusuri/aegis-ai-browser/issues/new`
    + `?title=${encodeURIComponent(`[Extension] ${entry.name} v${entry.version}`)}`
    + `&body=${encodeURIComponent(body)}`;
}

// Electron 45 moved extension APIs to session.extensions.* (the old flat
// session.loadExtension etc. are deprecated). Support both.
function extApi(ses) {
  const modern = ses.extensions;
  return {
    load: (dir, opts) => (modern ? modern.loadExtension(dir, opts) : ses.loadExtension(dir, opts)),
    remove: async (id) => (modern ? modern.removeExtension(id) : ses.removeExtension(id)),
    all: async () => (modern ? modern.getAllExtensions() : ses.getAllExtensions()),
  };
}

class ExtensionStore {
  /**
   * @param {{ getSession: () => Electron.Session,
   *          getSettings: () => any,
   *          setSettings: (patch: object) => void,
   *          getStoreDir?: () => string,
   *          indexUrl?: string }} deps
   */
  constructor({ getSession, getSettings, setSettings, getStoreDir, indexUrl } = {}) {
    this.getSession = getSession;
    this.getSettings = getSettings;
    this.setSettings = setSettings;
    this.getStoreDir = getStoreDir || (() => path.join(os.tmpdir(), 'aegis-ext-store'));
    this.indexUrl = indexUrl || STORE_INDEX_URL;
    this.remote = [];
    this.loadCache();
  }

  // ---- community catalog cache ---------------------------------------
  storeDir() { return this.getStoreDir(); }
  cacheFile() { return path.join(this.storeDir(), 'store-cache.json'); }

  loadCache() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.cacheFile(), 'utf8'));
      this.remote = normalizeCatalog(raw && raw.items);
    } catch {
      this.remote = [];
    }
  }

  remoteEntries() { return this.remote.slice(); }

  remoteDir(id) { return path.join(this.storeDir(), 'remote-' + safeId(id)); }

  // Fetch the GitHub-hosted catalog. Only https, size-capped, validated.
  async refresh() {
    const buf = await this.download(this.indexUrl, 1024 * 1024);
    let data;
    try { data = JSON.parse(buf.toString('utf8')); } catch { throw new Error('The community catalog is not valid JSON.'); }
    const items = normalizeCatalog(data);
    this.remote = items;
    try {
      fs.mkdirSync(this.storeDir(), { recursive: true });
      fs.writeFileSync(this.cacheFile(), JSON.stringify({ at: Date.now(), items }, null, 2));
    } catch { /* cache is best-effort */ }
    return { ok: true, count: items.length, items };
  }

  async download(url, maxBytes) {
    const parsed = new URL(String(url));
    if (parsed.protocol !== 'https:') throw new Error('Only https:// links are allowed.');
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 25000);
    try {
      const res = await fetch(parsed.href, {
        signal: ctrl.signal,
        redirect: 'follow',
        headers: { 'user-agent': 'Aegis-Extension-Store/1.1' },
      });
      if (!res.ok) throw new Error(`Download failed (HTTP ${res.status}).`);
      if (new URL(res.url).protocol !== 'https:') throw new Error('The download was redirected to an insecure URL.');
      const len = Number(res.headers.get('content-length') || 0);
      if (len && len > maxBytes) throw new Error('The file is too large.');
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > maxBytes) throw new Error('The file is too large.');
      return buf;
    } finally {
      clearTimeout(timer);
    }
  }

  // ---- persisted state ------------------------------------------------
  installedKeys() {
    const s = this.getSettings();
    return Array.isArray(s.installedExtensions) ? s.installedExtensions : [];
  }

  externalPaths() {
    const s = this.getSettings();
    return Array.isArray(s.externalExtensions) ? s.externalExtensions : [];
  }

  idMap() {
    const s = this.getSettings();
    return s.extensionIds && typeof s.extensionIds === 'object' ? s.extensionIds : {};
  }

  saveKey(key, electronId) {
    this.setSettings({ extensionIds: { ...this.idMap(), [key]: electronId } });
  }

  dropKey(key) {
    const map = { ...this.idMap() };
    delete map[key];
    this.setSettings({ extensionIds: map });
  }

  // ---- catalog + live state ------------------------------------------
  async list() {
    const ses = this.getSession();
    let loaded = [];
    try { loaded = await extApi(ses).all(); } catch { /* session not ready */ }
    const byId = new Map(loaded.map((e) => [e.id, e]));
    const installed = new Set(this.installedKeys());
    const externals = this.externalPaths();
    const externalSet = new Set(externals);
    const map = this.idMap();
    const remoteRoot = this.storeDir() + path.sep;

    const items = CATALOG.map((c) => {
      const dir = path.join(EXTENSIONS_DIR, c.id);
      const mf = readManifest(dir) || {};
      const electronId = map[c.id];
      const live = !!(electronId && byId.has(electronId));
      return {
        key: c.id,
        id: c.id,                       // catalog/folder id (stable key)
        emoji: c.emoji,
        tagline: c.tagline,
        category: c.category,
        rating: c.rating,
        users: c.users,
        name: mf.name || c.id,
        version: mf.version || '1.0.0',
        description: mf.description || c.tagline,
        external: false,
        bundled: true,
        community: false,
        installed: installed.has(c.id) && live,
        loaded: live,
      };
    });

    // Unpacked extensions the user loaded manually (remote installs are
    // represented by the community entries below, not as anonymous folders).
    for (const dir of externals) {
      if (dir.startsWith(remoteRoot)) continue;
      const mf = readManifest(dir);
      if (!mf) continue;
      const electronId = map[dir];
      const live = !!(electronId && byId.has(electronId));
      items.push({
        key: dir,
        id: dir,
        emoji: '📦',
        tagline: mf.description || 'Unpacked extension loaded from disk.',
        category: 'Unpacked',
        rating: null,
        users: null,
        name: mf.name || path.basename(dir),
        version: mf.version || '',
        description: mf.description || '',
        external: true,
        bundled: false,
        community: false,
        installed: live,
        loaded: live,
        path: dir,
      });
    }

    // Community catalog (cached; refreshed explicitly from the store UI).
    const bundledIds = new Set(CATALOG.map((c) => c.id));
    for (const c of this.remote) {
      if (bundledIds.has(c.id)) continue;
      const dir = this.remoteDir(c.id);
      const electronId = map[dir];
      const live = !!(electronId && byId.has(electronId));
      items.push({
        key: `remote:${c.id}`,
        id: c.id,
        emoji: c.emoji || '🧩',
        tagline: c.description || c.category,
        category: c.category || 'Community',
        rating: null,
        users: null,
        name: c.name,
        version: c.version,
        description: c.description || '',
        author: c.author || '',
        homepage: c.homepage || '',
        external: false,
        bundled: false,
        community: true,
        installed: externalSet.has(dir) && live,
        loaded: live,
        path: dir,
      });
    }

    return {
      items,
      count: items.filter((i) => i.loaded).length,
      bundled: CATALOG.length,
      community: this.remote.length,
      remoteAt: this.remote.length ? this.remote[0].updated || '' : '',
    };
  }

  // ---- operations -----------------------------------------------------
  async install(key) {
    const raw = String(key);

    // Community extension: resolve the catalog entry, then download + verify.
    if (raw.startsWith('remote:')) {
      const id = raw.slice(7);
      const entry = this.remote.find((e) => e.id === id);
      if (!entry) throw new Error('That extension is no longer in the community catalog. Refresh and try again.');
      const dir = this.remoteDir(entry.id);
      if (this.externalPaths().includes(dir)) {
        await this.loadInstalled();
        return { ok: true, key: raw };
      }
      return this.installFromUrl(entry.downloadUrl, entry.sha256, entry.id);
    }

    if (this.installedKeys().includes(raw)) {
      // Already installed — make sure it's actually loaded.
      await this.loadInstalled();
      return { ok: true, key: raw };
    }
    const dir = path.join(EXTENSIONS_DIR, raw);
    if (!readManifest(dir)) throw new Error(`No valid extension at "${raw}"`);
    const ses = this.getSession();
    const ext = await extApi(ses).load(dir, { allowFileAccess: false });
    this.saveKey(raw, ext.id);
    this.setSettings({ installedExtensions: [...this.installedKeys(), raw] });
    return { ok: true, key: raw, name: ext.name, id: ext.id };
  }

  async uninstall(key) {
    const raw = String(key);
    const externalKey = raw.startsWith('remote:') ? this.remoteDir(raw.slice(7)) : raw;
    const ses = this.getSession();
    const electronId = this.idMap()[externalKey] || this.idMap()[raw];
    if (electronId) {
      try { await extApi(ses).remove(electronId); } catch { /* already gone */ }
    }
    this.dropKey(externalKey);
    this.dropKey(raw);
    this.setSettings({ installedExtensions: this.installedKeys().filter((k) => k !== raw) });
    this.setSettings({
      externalExtensions: this.externalPaths().filter((p) => p !== externalKey && p !== raw),
    });
    return { ok: true, key: raw };
  }

  // Chrome-style "Load unpacked": pick a folder containing manifest.json.
  async loadUnpacked(dir) {
    if (!dir || typeof dir !== 'string') throw new Error('No folder chosen');
    const mf = readManifest(dir);
    if (!mf) throw new Error('That folder has no valid manifest.json');
    if (![2, 3].includes(mf.manifest_version)) {
      throw new Error(`Unsupported manifest_version ${mf.manifest_version}`);
    }
    const ses = this.getSession();
    const ext = await extApi(ses).load(dir, { allowFileAccess: false });
    this.saveKey(dir, ext.id);
    if (!this.externalPaths().includes(dir)) {
      this.setSettings({ externalExtensions: [...this.externalPaths(), dir] });
    }
    return { ok: true, key: dir, name: ext.name, id: ext.id };
  }

  // Download + verify + unpack a community package into userData.
  async installFromUrl(url, sha256, idHint) {
    const parsed = new URL(String(url));
    if (parsed.protocol !== 'https:') throw new Error('Only https:// extension packages are allowed.');
    const buf = await this.download(parsed.href, MAX_ZIP_BYTES);
    const actual = crypto.createHash('sha256').update(buf).digest('hex');
    if (sha256 && String(sha256).toLowerCase() !== actual) {
      throw new Error('SHA-256 mismatch — the package may have been tampered with.');
    }

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-ext-'));
    try {
      extractZipBuffer(buf, tmp);
      const root = findManifestRoot(tmp);
      if (!root) throw new Error('No manifest.json found in the package.');
      const mf = readManifest(root);
      if (!mf) throw new Error('The package manifest.json is invalid.');
      if (![2, 3].includes(mf.manifest_version)) {
        throw new Error(`Unsupported manifest_version ${mf.manifest_version}`);
      }

      const id = safeId(idHint || mf.name);
      const dest = this.remoteDir(id);

      // Replace a previous copy (and unload it first so Electron can reload).
      const existing = this.idMap()[dest];
      if (existing) {
        try { await extApi(this.getSession()).remove(existing); } catch { /* already gone */ }
        this.dropKey(dest);
      }
      fs.rmSync(dest, { recursive: true, force: true });
      fs.mkdirSync(dest, { recursive: true });
      fs.cpSync(root, dest, { recursive: true });

      const loaded = await this.loadUnpacked(dest);
      return {
        ...loaded,
        sha256: actual,
        version: mf.version || '',
        verified: !!sha256,
      };
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  // ---- publishing (free, GitHub-hosted catalog) -----------------------
  inspect(dir) {
    if (!dir || typeof dir !== 'string') throw new Error('Choose an extension folder first.');
    const mf = readManifest(dir);
    if (!mf) throw new Error('That folder has no valid manifest.json');
    if (![2, 3].includes(mf.manifest_version)) {
      throw new Error(`Unsupported manifest_version ${mf.manifest_version}`);
    }
    return {
      ok: true,
      dir,
      id: safeId(mf.name),
      manifest: {
        name: mf.name,
        version: mf.version || '0.0.0',
        description: mf.description || '',
        manifest_version: mf.manifest_version,
        permissions: Array.isArray(mf.permissions) ? mf.permissions.slice(0, 30) : [],
      },
    };
  }

  packageExtension(dir, meta = {}, outPath) {
    const info = this.inspect(dir);
    if (!outPath) throw new Error('No output path chosen.');
    const mf = readManifest(dir);
    const name = String(meta.name || mf.name).trim().slice(0, 80) || mf.name;
    const version = String(meta.version || mf.version || '1.0.0').trim().slice(0, 32);
    const id = safeId(meta.id || name);
    const zip = new AdmZip();
    zip.addLocalFolder(dir);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    zip.writeZip(outPath);
    const size = fs.statSync(outPath).size;
    if (size > 50 * 1024 * 1024) {
      fs.rmSync(outPath, { force: true });
      throw new Error('The package is larger than 50 MB.');
    }
    const sha256 = crypto.createHash('sha256').update(fs.readFileSync(outPath)).digest('hex');
    const https = (v) => (/^https:\/\/\S+$/i.test(String(v || '').trim()) ? String(v).trim() : '');
    const entry = {
      id,
      name,
      version,
      description: String(meta.description || mf.description || '').trim().slice(0, 280),
      author: String(meta.author || '').trim().slice(0, 80),
      category: String(meta.category || 'Community').trim().slice(0, 40),
      emoji: String(meta.emoji || '🧩').trim().slice(0, 8),
      homepage: https(meta.homepage),
      downloadUrl: https(meta.downloadUrl),
      sha256,
      updated: new Date().toISOString().slice(0, 10),
    };
    return { ok: true, zipPath: outPath, size, sha256, entry, manifest: info.manifest };
  }

  // Called once at startup: Electron forgets loaded extensions on restart,
  // so re-load everything the user installed. Failures on individual items
  // (moved/deleted folders) are skipped rather than fatal.
  async loadInstalled() {
    const ses = this.getSession();
    const keys = [
      ...this.installedKeys().map((k) => ({ key: k, dir: path.join(EXTENSIONS_DIR, k) })),
      ...this.externalPaths().map((p) => ({ key: p, dir: p })),
    ];
    const loadedNow = new Set((await extApi(ses).all()).map((e) => e.id));
    for (const { key, dir } of keys) {
      try {
        if (!readManifest(dir)) continue;
        const existing = this.idMap()[key];
        if (existing && loadedNow.has(existing)) continue;
        const ext = await extApi(ses).load(dir, { allowFileAccess: false });
        this.saveKey(key, ext.id);
      } catch (err) {
        console.warn('[ext] could not load', key, err.message);
      }
    }
    return keys.length;
  }
}

module.exports = {
  ExtensionStore,
  CATALOG,
  EXTENSIONS_DIR,
  STORE_INDEX_URL,
  safeId,
  normalizeCatalog,
  extractZipBuffer,
  findManifestRoot,
  buildSubmissionUrl,
};
