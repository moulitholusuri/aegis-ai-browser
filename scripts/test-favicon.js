'use strict';
// Unit/integration test for favicon inlining (run: npx electron scripts/test-favicon.js)
// Proves remote icons are fetched inside the tab session and returned as
// data: URLs, with caching, size limits and content-type checks.

const { app, session } = require('electron');
const http = require('http');
const { FaviconCache } = require('../src/main/favicon');

app.setPath('userData', require('path').join(require('os').tmpdir(), 'aegis-test-favicon'));

let pass = 0, fail = 0;
const check = (name, cond) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}`); }
};

// 1×1 PNG
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

app.whenReady().then(async () => {
  const hits = {};
  const server = http.createServer((req, res) => {
    hits[req.url] = (hits[req.url] || 0) + 1;
    if (req.url === '/favicon.png') {
      res.setHeader('content-type', 'image/png');
      res.end(PNG);
    } else if (req.url === '/big.png') {
      res.setHeader('content-type', 'image/png');
      res.end(Buffer.alloc(200 * 1024, 1));
    } else if (req.url === '/page.html') {
      res.setHeader('content-type', 'text/html');
      res.end('<h1>not an image</h1>');
    } else {
      res.statusCode = 404;
      res.end('nope');
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const cache = new FaviconCache(() => session.defaultSession, { timeoutMs: 1500 });

  console.log('— favicon inlining —');
  const data = await cache.dataUrl(`${base}/favicon.png`);
  check('returns a data: URL', /^data:image\/png;base64,/.test(data));
  check('payload decodes to the original PNG',
    Buffer.from(data.split(',')[1], 'base64').equals(PNG));

  const again = await cache.dataUrl(`${base}/favicon.png`);
  check('second call is served from cache', again === data && hits['/favicon.png'] === 1);

  check('rejects non-image content-type',
    (await cache.dataUrl(`${base}/page.html`)) === '');
  check('rejects oversized images',
    (await cache.dataUrl(`${base}/big.png`)) === '');
  check('404 yields no icon',
    (await cache.dataUrl(`${base}/missing.png`)) === '');
  check('non-http(s) schemes are ignored',
    (await cache.dataUrl('aegis://newtab')) === ''
    && (await cache.dataUrl('file:///etc/passwd')) === '');
  check('empty/undefined input is safe',
    (await cache.dataUrl('')) === '' && (await cache.dataUrl(undefined)) === '');

  // Concurrent requests for the same URL must share one network fetch.
  hits['/favicon.png'] = 0;
  const cache2 = new FaviconCache(() => session.defaultSession, { timeoutMs: 1500 });
  const [a, b, c] = await Promise.all([
    cache2.dataUrl(`${base}/favicon.png`),
    cache2.dataUrl(`${base}/favicon.png`),
    cache2.dataUrl(`${base}/favicon.png`),
  ]);
  check('concurrent requests are de-duplicated', a === b && b === c && hits['/favicon.png'] === 1);

  // Cache eviction stays bounded.
  const tiny = new FaviconCache(() => session.defaultSession, { maxEntries: 2 });
  await tiny.dataUrl(`${base}/favicon.png?1`);
  await tiny.dataUrl(`${base}/favicon.png?2`);
  await tiny.dataUrl(`${base}/favicon.png?3`);
  check('cache size is bounded', tiny.cache.size <= 2);

  console.log(`\n${pass} passed, ${fail} failed`);
  server.close();
  app.exit(fail ? 1 : 0);
});

setTimeout(() => { console.log('FAVICON TIMEOUT'); app.exit(1); }, 30000);
