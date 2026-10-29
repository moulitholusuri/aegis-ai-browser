'use strict';
// Extension store backend tests (no Electron, no network):
// catalog validation, zip safety, packaging + SHA-256, publishing metadata.
// Run with: node scripts/test-store-real.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const assert = require('assert');
const AdmZip = require('adm-zip');
const {
  ExtensionStore, safeId, normalizeCatalog, extractZipBuffer, findManifestRoot,
  buildSubmissionUrl,
} = require('../src/main/extensions');

let pass = 0, fail = 0;
const check = (name, fn) => {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.log(`  ✗ FAIL: ${name} — ${e.message}`); }
};
const checks = (name, fn) => {
  try { return Promise.resolve(fn()).then(
    () => { pass++; console.log(`  ✓ ${name}`); },
    (e) => { fail++; console.log(`  ✗ FAIL: ${name} — ${e.message}`); },
  ); } catch (e) {
    fail++; console.log(`  ✗ FAIL: ${name} — ${e.message}`);
    return Promise.resolve();
  }
};

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-store-test-'));

  check('safeId normalizes display names', () => {
    assert.strictEqual(safeId('My Extension!'), 'my-extension');
    assert.strictEqual(safeId('---'), 'extension');
  });

  check('catalog accepts valid HTTPS entries', () => {
    const items = normalizeCatalog({
      extensions: [{
        id: 'probe', name: 'Probe', version: '1.0.0', author: 'tester',
        downloadUrl: 'https://example.com/probe.zip',
        sha256: 'a'.repeat(64), homepage: 'https://example.com',
        category: 'Privacy', emoji: '🔬',
      }],
    });
    assert.strictEqual(items.length, 1);
    assert.strictEqual(items[0].id, 'probe');
    assert.strictEqual(items[0].sha256, 'a'.repeat(64));
  });

  check('catalog rejects HTTP, missing names and duplicates', () => {
    const items = normalizeCatalog([
      { id: 'a', name: 'A', downloadUrl: 'http://insecure.example/a.zip' },
      { id: 'b', downloadUrl: 'https://example.com/b.zip' },
      { id: 'c', name: 'C', downloadUrl: 'https://example.com/c.zip' },
      { id: 'c', name: 'C again', downloadUrl: 'https://example.com/c2.zip' },
      { id: 'd', name: 'D', downloadUrl: 'https://example.com/d.zip', sha256: 'nope' },
    ]);
    assert.deepStrictEqual(items.map((i) => i.id), ['c', 'd']);
    assert.strictEqual(items[1].sha256, '');
  });

  check('zip extraction blocks path traversal', () => {
    // AdmZip normalizes names on write, so build a minimal stored zip by hand.
    const makeZip = (name, data) => {
      const zlib = require('zlib');
      const n = Buffer.from(name);
      const crc = zlib.crc32(data);
      const lfh = Buffer.alloc(30);
      lfh.writeUInt32LE(0x04034b50, 0);
      lfh.writeUInt16LE(20, 4);
      lfh.writeUInt16LE(0, 6);
      lfh.writeUInt16LE(0, 8);
      lfh.writeUInt16LE(0, 10);
      lfh.writeUInt16LE(0, 12);
      lfh.writeUInt32LE(crc, 14);
      lfh.writeUInt32LE(data.length, 18);
      lfh.writeUInt32LE(data.length, 22);
      lfh.writeUInt16LE(n.length, 26);
      lfh.writeUInt16LE(0, 28);
      const local = Buffer.concat([lfh, n, data]);
      const cd = Buffer.alloc(46);
      cd.writeUInt32LE(0x02014b50, 0);
      cd.writeUInt16LE(20, 4);
      cd.writeUInt16LE(20, 6);
      cd.writeUInt16LE(0, 8);
      cd.writeUInt16LE(0, 10);
      cd.writeUInt16LE(0, 12);
      cd.writeUInt16LE(0, 14);
      cd.writeUInt32LE(crc, 16);
      cd.writeUInt32LE(data.length, 20);
      cd.writeUInt32LE(data.length, 24);
      cd.writeUInt16LE(n.length, 28);
      cd.writeUInt16LE(0, 30);
      cd.writeUInt16LE(0, 32);
      cd.writeUInt16LE(0, 34);
      cd.writeUInt16LE(0, 36);
      cd.writeUInt32LE(0, 38);
      cd.writeUInt32LE(0, 42);
      const central = Buffer.concat([cd, n]);
      const eocd = Buffer.alloc(22);
      eocd.writeUInt32LE(0x06054b50, 0);
      eocd.writeUInt16LE(0, 4);
      eocd.writeUInt16LE(0, 6);
      eocd.writeUInt16LE(1, 8);
      eocd.writeUInt16LE(1, 10);
      eocd.writeUInt32LE(central.length, 12);
      eocd.writeUInt32LE(local.length, 16);
      eocd.writeUInt16LE(0, 20);
      return Buffer.concat([local, central, eocd]);
    };
    const evil = makeZip('../evil.txt', Buffer.from('nope'));
    assert.throws(() => extractZipBuffer(evil, path.join(dir, 'evil')), /unsafe path/);
  });

  check('zip extraction handles a nested top-level folder', () => {
    const zip = new AdmZip();
    zip.addFile('my-ext/manifest.json', Buffer.from(JSON.stringify({ manifest_version: 3, name: 'Nested', version: '1.0.0' })));
    zip.addFile('my-ext/c.js', Buffer.from('document.title="x";'));
    const out = path.join(dir, 'nested');
    fs.mkdirSync(out, { recursive: true });
    extractZipBuffer(zip.toBuffer(), out);
    const root = findManifestRoot(out);
    assert.ok(root, 'manifest root not found');
    assert.ok(root.endsWith('my-ext'));
  });

  // A realistic extension folder for packaging.
  const extDir = path.join(dir, 'src-ext');
  fs.mkdirSync(extDir, { recursive: true });
  fs.writeFileSync(path.join(extDir, 'manifest.json'), JSON.stringify({
    manifest_version: 3,
    name: 'Probe Extension',
    version: '1.2.3',
    description: 'A probe used by the test suite.',
    permissions: ['storage'],
  }));
  fs.writeFileSync(path.join(extDir, 'c.js'), 'document.title = "probe";');

  const store = new ExtensionStore({
    getSession: () => null,
    getSettings: () => ({}),
    setSettings: () => {},
    getStoreDir: () => path.join(dir, 'store'),
  });

  check('inspect() reads the manifest', () => {
    const info = store.inspect(extDir);
    assert.strictEqual(info.manifest.name, 'Probe Extension');
    assert.strictEqual(info.id, 'probe-extension');
    assert.deepStrictEqual(info.manifest.permissions, ['storage']);
  });

  check('packageExtension() writes a zip with the right hash + entry', () => {
    const out = path.join(dir, 'Probe.zip');
    const built = store.packageExtension(extDir, {
      author: 'tester',
      category: 'Productivity',
      homepage: 'https://example.com/probe',
      downloadUrl: 'https://example.com/probe.zip',
      description: 'Probe description',
    }, out);
    assert.ok(fs.existsSync(out));
    assert.ok(built.size > 0);
    assert.strictEqual(built.entry.id, 'probe-extension');
    assert.strictEqual(built.entry.version, '1.2.3');
    assert.strictEqual(built.entry.author, 'tester');
    const hash = crypto.createHash('sha256').update(fs.readFileSync(out)).digest('hex');
    assert.strictEqual(built.sha256, hash);
    const zip = new AdmZip(out);
    const names = zip.getEntries().map((e) => e.entryName);
    assert.ok(names.includes('manifest.json'));
    assert.ok(names.includes('c.js'));
  });

  check('submission URL is a prefilled GitHub issue', () => {
    const url = buildSubmissionUrl({
      id: 'probe', name: 'Probe Extension', version: '1.2.3', author: 'tester',
      category: 'Productivity', homepage: 'https://example.com', downloadUrl: 'https://example.com/p.zip',
      sha256: 'b'.repeat(64), description: 'hi',
    });
    assert.ok(url.startsWith('https://github.com/moulitholusuri/aegis-ai-browser/issues/new?'));
    assert.ok(url.includes('Probe%20Extension'));
    assert.ok(url.includes('b'.repeat(64)));
  });

  await checks('installFromUrl rejects non-HTTPS links', async () => {
    await assert.rejects(() => store.installFromUrl('http://example.com/x.zip'), /https/);
  });
  await checks('installFromUrl rejects a checksum mismatch', async () => {
    const original = store.download;
    store.download = async () => Buffer.from('not really a zip');
    try {
      await assert.rejects(
        () => store.installFromUrl('https://example.com/x.zip', '0'.repeat(64)),
        /SHA-256 mismatch/,
      );
    } finally {
      store.download = original;
    }
  });

  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
