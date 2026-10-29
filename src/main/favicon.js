'use strict';
// Remote tab favicons → data: URLs, fetched INSIDE the tab session so the
// request uses the same proxy/anonymity route and ad/tracker guard as the page
// itself. The chrome UI keeps its strict CSP (img-src 'self' data:) and never
// talks to the network directly.
//
// Electron-free except for the session object passed in, so it can be tested.

const MAX_BYTES = 128 * 1024;
const MAX_ENTRIES = 300;
const TIMEOUT_MS = 2500;

class FaviconCache {
  /**
   * @param {() => Electron.Session} getSession  session used to fetch icons
   * @param {{ maxBytes?: number, maxEntries?: number, timeoutMs?: number }} [opts]
   */
  constructor(getSession, opts = {}) {
    this.getSession = getSession;
    this.maxBytes = opts.maxBytes || MAX_BYTES;
    this.maxEntries = opts.maxEntries || MAX_ENTRIES;
    this.timeoutMs = opts.timeoutMs || TIMEOUT_MS;
    this.cache = new Map();     // url -> data: URL ('' = unavailable)
    this.inflight = new Map();  // url -> Promise<string>
  }

  async dataUrl(rawUrl) {
    if (!rawUrl || !/^https?:\/\//i.test(rawUrl)) return '';
    if (this.cache.has(rawUrl)) return this.cache.get(rawUrl);
    if (this.inflight.has(rawUrl)) return this.inflight.get(rawUrl);

    const task = (async () => {
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
        try {
          const res = await this.getSession().fetch(rawUrl, { signal: ctrl.signal });
          if (!res.ok) return '';
          const type = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
          if (!/^image\//.test(type)) return '';
          const buf = Buffer.from(await res.arrayBuffer());
          if (!buf.length || buf.length > this.maxBytes) return '';
          return `data:${type};base64,${buf.toString('base64')}`;
        } finally {
          clearTimeout(timer);
        }
      } catch {
        return '';
      }
    })();

    this.inflight.set(rawUrl, task);
    const result = await task;
    this.inflight.delete(rawUrl);
    if (this.cache.size >= this.maxEntries) {
      this.cache.delete(this.cache.keys().next().value);
    }
    this.cache.set(rawUrl, result);
    return result;
  }
}

module.exports = { FaviconCache };
