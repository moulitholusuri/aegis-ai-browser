'use strict';
// Shared aegis:// protocol handler.
// IMPORTANT: with standard-scheme privileges, `aegis://search?q=x` parses as
// host="search", path="/", and `aegis://search/api/search` as host="search",
// path="/api/search" — so routing must be host-based, not path-based.
// The handler must ALSO be registered on the session that serves the tabs
// (persist:aegis-browse), not just the default session.

const { searchPageHtml } = require('./search-page');

const NEWTAB_HTML = '<!DOCTYPE html><meta charset="utf-8"><title>Aegis</title>' +
  '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'">' +
  '<body style="background:#0b0f14;color:#dbe7f5;font-family:sans-serif;display:flex;' +
  'align-items:center;justify-content:center;height:100vh;margin:0">' +
  '<div style="text-align:center"><h1>🛡️ Aegis</h1>' +
  '<p>Use the address bar above to search or browse.</p></div></body>';

function makeSearchHandler(search) {
  return async (request) => {
    let url;
    try { url = new URL(request.url); } catch {
      return new Response('Bad URL', { status: 400 });
    }
    const host = url.hostname.toLowerCase();
    const pathName = (url.pathname || '/').replace(/\/+$/, '') || '/';

    // ---- aegis://search[/...] — results page + streaming API ----
    if (host === 'search') {
      // Streaming NDJSON endpoint: one JSON event per line as sources respond.
      if (pathName === '/api/search' || pathName === '/search/api/search') {
        const q = (url.searchParams.get('q') || '').slice(0, 300);
        const encoder = new TextEncoder();
        const stream = new ReadableStream({
          start(controller) {
            let closed = false;
            const push = (obj) => {
              if (closed) return;
              try { controller.enqueue(encoder.encode(JSON.stringify(obj) + '\n')); }
              catch { closed = true; }
            };
            search.search(q, push)
              .then(() => {
                if (!closed) { closed = true; try { controller.close(); } catch { /* ignore */ } }
              })
              .catch((err) => {
                push({ type: 'error', message: String(err.message || err) });
                try { controller.close(); } catch { /* ignore */ }
              });
          },
        });
        return new Response(stream, {
          headers: {
            'content-type': 'application/x-ndjson; charset=utf-8',
            'cache-control': 'no-store',
          },
        });
      }

      // Results page (both aegis://search?q= and aegis://search/?q= forms).
      const q = url.searchParams.get('q') || '';
      return new Response(searchPageHtml(q, { cloud: search.hasCloud() }), {
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    }

    // ---- aegis://newtab — minimal internal page (renderer chrome handles the real NTP) ----
    if (host === 'newtab' || host === '') {
      return new Response(NEWTAB_HTML, { headers: { 'content-type': 'text/html; charset=utf-8' } });
    }

    return new Response('Not found', { status: 404 });
  };
}

module.exports = { makeSearchHandler };
