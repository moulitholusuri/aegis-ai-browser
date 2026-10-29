'use strict';
// Debug: dump raw responses from each source to diagnose empty results.
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

(async () => {
  const q = 'privacy browser';

  console.log('=== Wikipedia ===');
  try {
    const res = await fetch(`https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(q)}&srlimit=3&format=json&utf8=1&srprop=snippet|timestamp`, { headers: { 'user-agent': UA } });
    console.log('status', res.status);
    const j = await res.json();
    console.log('keys:', Object.keys(j));
    console.log(JSON.stringify(j).slice(0, 400));
  } catch (e) { console.log('ERR', e.message); }

  console.log('\n=== GitHub ===');
  try {
    const res = await fetch(`https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&sort=stars&order=desc&per_page=3`, { headers: { 'user-agent': UA, accept: 'application/vnd.github+json' } });
    console.log('status', res.status);
    const j = await res.json();
    console.log('items:', (j.items || []).length, j.message || '');
    if (j.items) console.log(j.items.slice(0, 2).map(i => i.full_name));
  } catch (e) { console.log('ERR', e.message); }

  console.log('\n=== HN Algolia ===');
  try {
    const res = await fetch(`https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(q)}&hitsPerPage=3&tags=story`, { headers: { 'user-agent': UA } });
    console.log('status', res.status);
    const j = await res.json();
    console.log('hits:', (j.hits || []).length);
  } catch (e) { console.log('ERR', e.message); }

  console.log('\n=== DDG Lite (POST) ===');
  try {
    const res = await fetch('https://lite.duckduckgo.com/lite/', {
      method: 'POST',
      headers: { 'user-agent': UA, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ q, kl: 'wt-wt' }).toString(),
    });
    console.log('status', res.status);
    const html = await res.text();
    console.log('len:', html.length);
    console.log('result-link count:', (html.match(/result-link/g) || []).length);
    console.log('snippet count:', (html.match(/result-snippet/g) || []).length);
    console.log('has anomaly:', html.includes('anomaly') || html.includes('challenge'));
    // show a sample anchor
    const m = html.match(/<a[^>]{0,200}href="[^"]{0,200}"/g);
    console.log('sample anchors:', (m || []).slice(0, 3));
  } catch (e) { console.log('ERR', e.message); }

  console.log('\n=== Mojeek ===');
  try {
    const res = await fetch(`https://www.mojeek.com/search?q=${encodeURIComponent(q)}`, { headers: { 'user-agent': UA, accept: 'text/html' } });
    console.log('status', res.status);
    const html = await res.text();
    console.log('len:', html.length);
    console.log('title-class count:', (html.match(/class="title"/g) || []).length);
    console.log('ob count:', (html.match(/class="ob"/g) || []).length);
    const m = html.match(/<a[^>]{0,150}href="https?:[^"]{0,120}"/g);
    console.log('sample:', (m || []).slice(0, 4));
  } catch (e) { console.log('ERR', e.message); }

  console.log('\n=== Reddit ===');
  try {
    const res = await fetch(`https://www.reddit.com/search.json?q=${encodeURIComponent(q)}&limit=3&raw_json=1`, { headers: { 'user-agent': UA } });
    console.log('status', res.status);
    if (res.ok) { const j = await res.json(); console.log('children:', (j.data?.children || []).length); }
  } catch (e) { console.log('ERR', e.message); }

  console.log('\n=== StackExchange ===');
  try {
    const res = await fetch(`https://api.stackexchange.com/2.3/search/excerpts?order=desc&sort=relevance&q=${encodeURIComponent(q)}&site=stackoverflow&pagesize=3&filter=default`, { headers: { 'user-agent': UA } });
    console.log('status', res.status);
    const j = await res.json();
    console.log('items:', (j.items || []).length, j.error_message || '');
    if (j.items) console.log(j.items.slice(0, 2).map(i => ({ type: i.item_type, t: (i.title || '').slice(0, 40) })));
  } catch (e) { console.log('ERR', e.message); }
})();
