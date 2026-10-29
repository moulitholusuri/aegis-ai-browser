'use strict';
// Unit tests for the ErrorModel (run: node scripts/test-diag.js)

const fs = require('fs');
const os = require('os');
const path = require('path');
const { ErrorModel, fingerprint, explain } = require('../src/main/diagnostics');

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}`); }
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-diag-'));
const file = path.join(tmpDir, 'diagnostics.json');
const events = [];

console.log('— fingerprinting (dedupe identical errors) —');
check('same type+text → same key',
  fingerprint('console', 'Failed to load resource') === fingerprint('console', 'Failed to load resource'));
check('numbers normalized (same group)',
  fingerprint('ipc:x', 'handler failed for id 12345') === fingerprint('ipc:x', 'handler failed for id 99999'));
check('URLs reduced to host',
  fingerprint('net:-105', 'cannot open https://shop.example.com/a?b=1').includes('shop.example.com'));
check('different types → different groups',
  fingerprint('ipc:a', 'boom') !== fingerprint('ipc:b', 'boom'));

console.log('— knowledge base (plain-language explanations) —');
check('DNS error explained', explain('net:-105', '').title.includes('Name not resolved'));
check('DNS advice mentions proxy', /proxy|DNS/i.test(explain('net:-105', '').advice));
check('IPC error names the channel', explain('ipc:settings:get', '').advice.includes('settings:get'));
check('search source advice', explain('search-source:wikipedia', '').title.includes('Search source'));
check('unknown type still gets advice', explain('mystery:thing', '').advice.length > 10);

console.log('— recording + counting —');
const m1 = new ErrorModel(file, (ev) => events.push(ev));
m1.record({ source: 'ipc', type: 'ipc:settings:get', message: 'object could not be cloned' });
m1.record({ source: 'ipc', type: 'ipc:settings:get', message: 'object could not be cloned' });
m1.record({ source: 'ipc', type: 'ipc:settings:get', message: 'object could not be cloned' });
m1.record({ source: 'network', type: 'net:-105', message: 'ERR_NAME_NOT_RESOLVED — typo.example' , severity: 'warn' });
let r = m1.report();
check('two distinct groups', r.groups === 2);
check('total occurrences = 4', r.events === 4);
check('repeats counted ×3', r.top[0].count === 3);
check('sorted by count desc', r.top[0].count >= r.top[1].count);
check('groups carry title+advice', !!r.top[0].title && !!r.top[0].advice);
check('bySource aggregated', r.bySource.ipc === 3 && r.bySource.network === 1);
check('emitted events with counts', events.length === 4 && events[0].count === 1 && events[2].count === 3);
check('first record marked new, repeats not', events[0].isNew === true && events[1].isNew === false);
check('unread tracks new groups', r.unread === 2);

console.log('— seen / markSeen —');
m1.markSeen();
r = m1.report();
check('unread cleared after seen', r.unread === 0);
m1.record({ source: 'main', type: 'uncaught', message: 'kaboom' });
check('new error re-arms unread', m1.report().unread === 1);

console.log('— persistence —');
m1.flush(); // app flushes on quit so debounced counts are never lost
const m2 = new ErrorModel(file, () => {});
const r2 = m2.report();
check('groups survive reload', r2.groups === 3 && r2.events === 5);
check('counts survive reload', r2.top.find((g) => g.type === 'ipc:settings:get').count === 3);

console.log('— IPC instrumentation —');
const fakeIpc = {
  handlers: {},
  handle(ch, fn) { this.handlers[ch] = fn; },
};
const m3 = new ErrorModel(path.join(tmpDir, 'd2.json'), () => {});
m3.instrumentIpc(fakeIpc);
let thrown = null;
(async () => {
  fakeIpc.handle('good', () => ({ ok: 1 }));
  fakeIpc.handle('bad', () => { throw new Error('handler exploded'); });
  const ok = await fakeIpc.handlers.good({}, {});
  check('working handler passes through', ok && ok.ok === 1);
  try { await fakeIpc.handlers.bad({}, {}); } catch (e) { thrown = e; }
  check('error still re-thrown to caller', thrown && thrown.message === 'handler exploded');
  const rr = m3.report();
  check('handler failure recorded with channel', rr.groups === 1 && rr.top[0].type === 'ipc:bad');
  check('counts handler occurrences', rr.top[0].count === 1);

  console.log('— report formatting —');
  const text = m1.formatReport(m1.report());
  check('report shows occurrence total', /occurrence/.test(text));
  check('report shows ×counts', /×3/.test(text));
  check('healthy report when empty', /healthy/.test(new ErrorModel(path.join(tmpDir, 'd3.json'), () => {}).formatReport(new ErrorModel(path.join(tmpDir, 'd3.json'), () => {}).report())));

  console.log('— retention prune —');
  const m4 = new ErrorModel(path.join(tmpDir, 'd4.json'), () => {});
  const g = m4.record({ source: 'x', type: 'old', message: 'ancient' });
  g.lastSeen = Date.now() - 9 * 24 * 60 * 60 * 1000; // 9 days old
  m4.prune();
  check('entries older than 7 days pruned', m4.report().groups === 0);

  fs.rmSync(tmpDir, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
