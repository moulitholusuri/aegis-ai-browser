'use strict';
// Dump raw HTML around result markers to fix parsers.
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

(async () => {
  const q = 'privacy browser';

  console.log('=== DDG LITE: raw around result-link ===');
  const ddg = await fetch('https://lite.duckduckgo.com/lite/', {
    method: 'POST',
    headers: { 'user-agent': UA, 'content-type': 'application/x-www-form-urlencoded', 'accept': 'text/html' },
    body: new URLSearchParams({ q, kl: 'wt-wt' }).toString(),
  }).then(r => r.text());
  const i = ddg.indexOf('result-link');
  console.log(i === -1 ? 'NO result-link FOUND' : ddg.slice(Math.max(0, i - 400), i + 600));
  console.log('\n--- links section ---');
  const j = ddg.indexOf('links_main');
  console.log(j === -1 ? 'no links_main' : ddg.slice(j - 100, j + 700));

  console.log('\n=== MOJEEK: full HTML head+body ===');
  const moj = await fetch(`https://www.mojeek.com/search?q=${encodeURIComponent(q)}`, {
    headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml', 'accept-language': 'en-US,en;q=0.9' },
  }).then(r => r.text());
  console.log('len', moj.length);
  console.log(moj.slice(0, 3000));

  console.log('\n=== REDDIT old.reddit ===');
  for (const [name, url, headers] of [
    ['old.reddit', `https://old.reddit.com/search.json?q=${encodeURIComponent(q)}&limit=3`, { 'user-agent': 'AegisBrowser/1.0 (privacy search; contact: local)' }],
    ['www+lang', `https://www.reddit.com/search.json?q=${encodeURIComponent(q)}&limit=3&raw_json=1`, { 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36', 'accept': 'application/json', 'accept-language': 'en-US,en;q=0.9' }],
  ]) {
    try {
      const r = await fetch(url, { headers });
      console.log(name, 'status', r.status);
      if (r.ok) { const j2 = await r.json(); console.log('  children', (j2.data?.children || []).length); }
    } catch (e) { console.log(name, 'ERR', e.message); }
  }

  console.log('\n=== niche query sanity: wikipedia/github for "electron protocol streaming ndjson" ===');
  const w = await fetch(`https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent('electron protocol streaming ndjson')}&srlimit=3&format=json&utf8=1`, { headers: { 'user-agent': UA } }).then(r => r.json());
  console.log('wiki hits:', w.query?.search?.length ?? 0, 'total:', w.query?.searchinfo?.totalhits);
})();
