'use strict';
// Link Scrubber — rewrites anchor hrefs so copied/shared links carry no
// tracking parameters. (Aegis already strips them on navigation; this makes
// the *visible and copied* link clean too.) Keeps same-origin links relative.
(() => {
  const EXACT = new Set([
    'fbclid', 'gclid', 'dclid', 'gad_source', 'msclkid', 'yclid', 'igshid',
    'mc_cid', 'mc_eid', 'mkt_tok', 'srsltid', 'ttclid', 'twclid', 'li_fat_id',
    'ref_src', 'ref_url', 'si', 'feature', 'share_id', 's_cid', 'wbraid', 'gbraid',
  ]);
  const PREFIXES = ['utm_', 'pk_', 'hsa_', 'vero_', 'mtm_', 'itm_'];

  const isTracky = (key) => {
    const k = key.toLowerCase();
    return EXACT.has(k) || PREFIXES.some((p) => k.startsWith(p));
  };

  const scrubAnchor = (a) => {
    const raw = a.getAttribute('href');
    if (!raw || raw.startsWith('#') || !raw.includes('?')) return;
    let u;
    try { u = new URL(raw, location.href); } catch { return; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return;
    let changed = false;
    for (const key of [...u.searchParams.keys()]) {
      if (isTracky(key)) { u.searchParams.delete(key); changed = true; }
    }
    if (!changed) return;
    a.setAttribute('href', u.origin === location.origin
      ? u.pathname + u.search + u.hash
      : u.href);
  };

  const scrubAll = (root) => {
    if (!root || !root.querySelectorAll) return;
    if (root.matches && root.matches('a[href]')) scrubAnchor(root);
    const list = root.querySelectorAll ? root.querySelectorAll('a[href]') : [];
    for (const a of list) scrubAnchor(a);
  };

  scrubAll(document);

  const mo = new MutationObserver((muts) => {
    for (const m of muts) {
      for (const n of m.addedNodes) if (n.nodeType === 1) scrubAll(n);
      if (m.type === 'attributes') scrubAnchor(m.target);
    }
  });
  mo.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['href'] });
})();
