'use strict';
// Unit tests for anonymity helpers (run: node scripts/test-anonymity.js)

const {
  chromeUA, stripTrackingParams, buildSearchUrl, parseBang, ENGINES,
  engineMap, normalizeCustomEngines, normalizeEngineUrl, applySearchSettings,
} = require('../src/main/anonymity');

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}`); }
}

console.log('— UA normalization —');
const ua = chromeUA();
check('no Electron token', !/electron/i.test(ua));
check('looks like Chrome', /Chrome\/\d+/.test(ua) && /Safari\/537/.test(ua));

console.log('— tracker param stripping —');
check('strips utm_ family', stripTrackingParams('https://x.com/a?utm_source=tw&utm_campaign=abc&id=1')
  === 'https://x.com/a?id=1');
check('strips gclid/fbclid/msclkid', !/gclid|fbclid|msclkid/.test(
  stripTrackingParams('https://shop.com/?gclid=123&fbclid=456&msclkid=789&item=9')));
check('strips share params (si, feature, igshid)', !/si=|feature=|igshid/.test(
  stripTrackingParams('https://youtube.com/watch?v=abc&si=xyz&feature=share&igshid=1')));
check('keeps normal params', stripTrackingParams('https://docs.rs/tokio/latest') === 'https://docs.rs/tokio/latest');
check('idempotent', stripTrackingParams(stripTrackingParams('https://x.com/?utm_source=a&b=2')) === 'https://x.com/?b=2');
check('leaves aegis:// alone', stripTrackingParams('aegis://search?q=hello') === 'aegis://search?q=hello');
check('cleans tracking hash', stripTrackingParams('https://x.com/a#utm_source=z') === 'https://x.com/a');

console.log('— bangs —');
check('!g routes to Google', parseBang('!g best browser')?.engine === 'google');
check('bang query parsed', parseBang('!g best browser')?.query === 'best browser');
check('!b routes to Bing', parseBang('!b windows update')?.engine === 'bing');
check('!yt routes to YouTube', parseBang('!yt lofi')?.engine === 'youtube');
check('!a forces Aegis', parseBang('!a privacy news')?.engine === 'aegis');
check('no bang -> null', parseBang('plain query') === null);
check('unknown bang -> null', parseBang('!zzz query') === null);

console.log('— engine routing —');
check('default engine used', buildSearchUrl('google', 'hello world')
  === 'https://www.google.com/search?q=hello%20world');
check('unknown engine falls back to aegis', buildSearchUrl('nope', 'x').startsWith('aegis://search'));
check('bang overrides default engine', buildSearchUrl('google', '!ddg private search')
  === 'https://duckduckgo.com/?q=private%20search');
check('bing url correct', ENGINES.bing.url('test q') === 'https://www.bing.com/search?q=test%20q');
check('startpage url correct', ENGINES.startpage.url('q') === 'https://www.startpage.com/sp/search?query=q');

console.log('— custom engines —');
const custom = {
  customEngines: [{ label: 'Ecosia', url: 'https://www.ecosia.org/search?q=%s', bang: 'eco' }],
};
const norm = normalizeCustomEngines(custom.customEngines);
check('normalizes with stable c1 key', norm.length === 1 && norm[0].key === 'c1');
check('engineMap includes custom engine + icon', engineMap(custom).c1?.label === 'Ecosia'
  && engineMap(custom).c1?.custom === true && engineMap(custom).c1?.icon === '🔎');
check('custom engine used as default', buildSearchUrl('c1', 'solar power', custom)
  === 'https://www.ecosia.org/search?q=solar%20power');
check('custom bang routes one-off searches', buildSearchUrl('aegis', '!eco solar power', custom)
  === 'https://www.ecosia.org/search?q=solar%20power');
check('{q} placeholder supported', buildSearchUrl('c1', 'a b', {
  customEngines: [{ label: 'X', url: 'https://x.example/?q={q}' }],
}) === 'https://x.example/?q=a%20b');
check('bare host gets https://', normalizeEngineUrl('example.com/search?q=%s')
  === 'https://example.com/search?q=%s');
check('template without placeholder rejected', normalizeEngineUrl('https://example.com/search') === null);
check('non-http(s) rejected', normalizeEngineUrl('ftp://example.com/?q=%s') === null);
check('built-in bang wins over a colliding custom bang',
  normalizeCustomEngines([{ label: 'G', url: 'https://g.example/?q=%s', bang: 'g' }])[0].bang === '');
check('custom bangs de-duplicated',
  normalizeCustomEngines([
    { label: 'A', url: 'https://a.example/?q=%s', bang: 'z' },
    { label: 'B', url: 'https://b.example/?q=%s', bang: 'z' },
  ])[1].bang === '');
check('custom engine list capped at 20',
  normalizeCustomEngines(Array.from({ length: 30 }, (_, i) => ({
    label: 'E' + i, url: `https://e${i}.example/?q=%s`,
  }))).length === 20);
check('invalid custom entry dropped (no label)', normalizeCustomEngines([
  { label: '', url: 'https://x.example/?q=%s' },
]).length === 0);

console.log('— search settings validation (applySearchSettings) —');
const base = {
  searchEngine: 'aegis',
  enabledEngines: ['aegis', 'google'],
  customEngines: [],
  searchSources: { web: true, knowledge: true, code: true, papers: true, discussions: true },
};
const s1 = applySearchSettings(base, {
  customEngines: [{ label: 'Ecosia', url: 'https://ecosia.org/?q=%s' }],
});
check('new custom engine auto-enabled', s1.enabledEngines.includes(s1.customEngines[0].key));
check('new custom engine is routable', buildSearchUrl(s1.customEngines[0].key, 'x', s1)
  .startsWith('https://ecosia.org/?q=x'));
const s2 = applySearchSettings(s1, { customEngines: [] });
check('removed engine pruned from enabled list',
  !s2.enabledEngines.some((k) => k.startsWith('c')));
check('unknown default falls back to aegis',
  applySearchSettings(base, { searchEngine: 'nope' }).searchEngine === 'aegis');
check('active default re-enabled when hidden',
  applySearchSettings(base, { enabledEngines: ['google'] }).enabledEngines.includes('aegis'));
check('unknown enabled engine dropped',
  !applySearchSettings(base, { enabledEngines: ['google', 'not-real'] }).enabledEngines.includes('not-real'));
check('empty enabled list falls back to aegis',
  applySearchSettings(base, { enabledEngines: [] }).enabledEngines.includes('aegis'));
const s6 = applySearchSettings(base, {
  searchSources: { web: false, knowledge: false, code: false, papers: false, discussions: false },
});
check('all sources off keeps web on', s6.searchSources.web === true);
const s7 = applySearchSettings(base, { searchSources: { web: true, papers: false } });
check('source patch merges with existing switches',
  s7.searchSources.papers === false && s7.searchSources.web === true);
check('unrelated settings survive a search patch',
  applySearchSettings({ ...base, autoCleanMinutes: 7 }, { searchEngine: 'google' }).autoCleanMinutes === 7);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
