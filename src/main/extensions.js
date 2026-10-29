'use strict';
// Aegis Extension Store — curated MV3 extensions bundled with the app plus a
// "load unpacked" escape hatch for power users (same as Chrome's dev mode).
//
// Extensions load into the BROWSE partition, so they run inside real tabs and
// behave exactly like Chrome extensions. Electron does not persist loaded
// extensions across restarts, so the installed set is stored in settings and
// re-loaded on every launch. Electron also assigns its own extension ids (not
// folder names), so we persist a key -> electron-id map for uninstall.

const path = require('path');
const fs = require('fs');

const EXTENSIONS_DIR = path.join(__dirname, '..', '..', 'extensions');

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
   *          setSettings: (patch: object) => void }} deps
   */
  constructor({ getSession, getSettings, setSettings }) {
    this.getSession = getSession;
    this.getSettings = getSettings;
    this.setSettings = setSettings;
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
    const map = this.idMap();

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
        installed: installed.has(c.id) && live,
        loaded: live,
      };
    });

    // Unpacked extensions the user loaded manually.
    for (const dir of this.externalPaths()) {
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
        installed: live,
        loaded: live,
        path: dir,
      });
    }

    return { items, count: items.filter((i) => i.loaded).length };
  }

  // ---- operations -----------------------------------------------------
  async install(key) {
    if (this.installedKeys().includes(key)) {
      // Already installed — make sure it's actually loaded.
      await this.loadInstalled();
      return { ok: true, key };
    }
    const dir = path.join(EXTENSIONS_DIR, key);
    if (!readManifest(dir)) throw new Error(`No valid extension at "${key}"`);
    const ses = this.getSession();
    const ext = await extApi(ses).load(dir, { allowFileAccess: false });
    this.saveKey(key, ext.id);
    this.setSettings({ installedExtensions: [...this.installedKeys(), key] });
    return { ok: true, key, name: ext.name, id: ext.id };
  }

  async uninstall(key) {
    const ses = this.getSession();
    const electronId = this.idMap()[key];
    if (electronId) {
      try { await extApi(ses).remove(electronId); } catch { /* already gone */ }
    }
    this.dropKey(key);
    this.setSettings({ installedExtensions: this.installedKeys().filter((k) => k !== key) });
    this.setSettings({ externalExtensions: this.externalPaths().filter((p) => p !== key) });
    return { ok: true, key };
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

module.exports = { ExtensionStore, CATALOG, EXTENSIONS_DIR };
