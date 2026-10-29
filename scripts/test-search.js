'use strict';
// Standalone tests for the Aegis search engine (run with: node scripts/test-search.js)

const { rankResults, detectIntent } = require('../src/main/search/ranker');
const { normalizeUrl, dedupe } = require('../src/main/search/engine');
const { LRUCache } = require('../src/main/search/cache');

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}`); }
}

console.log('— intent detection —');
check('definition', detectIntent('what is WebRTC leakage') === 'definition');
check('howto', detectIntent('how to encrypt a database') === 'howto');
check('comparison', detectIntent('rust vs go performance') === 'comparison');
check('news', detectIntent('latest electron release') === 'news');
check('code', detectIntent('python TypeError NoneType') === 'code');
check('research', detectIntent('arxiv transformers survey') === 'research');
check('general', detectIntent('best coffee shops') === 'commercial');

console.log('— ranking —');
const results = [
  { title: 'WebRTC IP Leak Test', url: 'https://example-webrtc.com/test', snippet: 'Test your browser for WebRTC IP leakage and fix it.', source: 'duckduckgo', date: Date.now() },
  { title: 'Random page', url: 'https://other.com/x', snippet: 'nothing relevant here at all', source: 'mojeek' },
  { title: 'WebRTC', url: 'https://en.wikipedia.org/wiki/WebRTC', snippet: 'WebRTC is a free, open-source project that enables real-time communication.', source: 'wikipedia' },
  { title: 'How to stop WebRTC leaks', url: 'https://blog.example.com/webrtc-leaks', snippet: 'WebRTC can leak your IP. Here is how to prevent WebRTC leakage in browsers.', source: 'hackernews', points: 350, date: Date.now() },
];
const ranked = rankResults(results, 'webrtc leak prevention');
check('relevant first', /webrtc/i.test(ranked.items[0].title));
check('irrelevant demoted', ranked.items[ranked.items.length - 1].title === 'Random page');
check('intent detected', ranked.intent === 'general' || ranked.intent === 'howto');

console.log('— url normalization / dedupe —');
check('strips utm', normalizeUrl('https://Site.com/a?utm_source=x&id=1#frag') === 'https://site.com/a?id=1');
check('dedupe by url+title', dedupe([
  { title: 'Same Title', url: 'https://a.com/x?utm_source=tw', snippet: '' },
  { title: 'Same Title', url: 'https://b.com/y', snippet: '' },
  { title: 'Different', url: 'https://b.com/y', snippet: '' },
]).length === 2);

console.log('— LRU cache —');
const c = new LRUCache(2, 1000);
c.set('a', 1); c.set('b', 2);
check('hit', c.get('a') === 1);
c.set('c', 3);
check('evicts oldest', c.get('b') === undefined && c.get('c') === 3);

// ---- live engine test (network) ----
(async () => {
  console.log('— live search (network) —');
  const { SearchEngine } = require('../src/main/search/engine');
  const engine = new SearchEngine({
    getSettings: () => ({ searchSources: { web: true, knowledge: true, code: true, papers: true, discussions: true } }),
    ai: { llmConfig: () => null }, // local mode
  });
  const events = [];
  const t0 = Date.now();
  const r = await engine.search('privacy focused browser', (e) => events.push(e.type));
  console.log(`  results: ${r.results.length}, intent: ${r.intent}, took: ${r.tookMs}ms (wall ${Date.now() - t0}ms)`);
  console.log(`  streaming events: ${events.filter(t => t === 'source').length} source + ${events.includes('answer') ? 1 : 0} answer + ${events.includes('done') ? 1 : 0} done`);
  for (const s of r.sources) console.log(`    ${s.error ? '✗' : '✓'} ${s.source}: ${s.count} results ${s.ms}ms${s.error ? ' (' + s.error + ')' : ''}`);
  check('got results', r.results.length > 0);
  check('streamed source events', events.filter(t => t === 'source').length >= 2);
  check('answer synthesized', !r.answer || typeof r.answer.text === 'string');
  const t1 = Date.now();
  const r2 = await engine.search('privacy focused browser');
  check('cache instant (<20ms)', Date.now() - t1 < 20 && r2.results.length === r.results.length);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('LIVE TEST ERROR:', e); process.exit(1); });
