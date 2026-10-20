// Self-check for builtins-scan. Run: node builtins-scan.test.js
const assert = require('assert');
const fs = require('fs'), os = require('os'), path = require('path');
const b = require('./builtins-scan');

const bin = 'xx\0type:"local-jsx",name:"btw",description:"Ask a \\"quick\\" side question"}junk'
  + 'type:"local",name:"heapdump",description:"Dump"type:"local",name:"model"'
  + 'type:"local-jsx",name:"extra-usage",description:"Renamed to /usage-credits"'
  + 'type:"prompt",name:"insights",description:"Report"';
const found = b.parseBuiltins(bin);
assert.strictEqual(found.get('btw'), 'Ask a "quick" side question');
assert.strictEqual(found.get('model'), '');

const fallback = [{ type: 'builtin', origin: 'builtin', group: 'Built-in', name: 'model', desc: 'Switch model', hint: '[model]', insert: '/model ' }];
assert.strictEqual(b.mergeBuiltins(found, fallback), fallback, 'too few scraped → hand-kept list');
for (let i = 0; i < 10; i++) found.set('c' + i, 'd');
const merged = b.mergeBuiltins(found, fallback);
const by = Object.fromEntries(merged.map(m => [m.name, m]));
assert.ok(!by.heapdump && !by['extra-usage'], 'internal and renamed commands dropped');
assert.deepStrictEqual([by.model.desc, by.model.hint, by.model.insert], ['Switch model', '[model]', '/model ']);
assert.deepStrictEqual([by.btw.type, by.btw.origin, by.btw.insert], ['builtin', 'builtin', '/btw ']);

// a command split across two read chunks is still found
const f = path.join(os.tmpdir(), `bscan-${process.pid}.bin`);
fs.writeFileSync(f, Buffer.concat([Buffer.alloc((8 << 20) - 20, 0x20), Buffer.from('type:"local",name:"goal",description:"Set a goal"')]));
b.scanClaudeBinary(f).then((m) => {
  fs.unlinkSync(f);
  assert.strictEqual(m.get('goal'), 'Set a goal');

  const seen = {}, items = [{ type: 'builtin', name: 'clear' }];
  assert.ok(!b.markNew(items, seen, 1000)[0].isNew, 'first run is the baseline');
  const later = b.markNew([...items, { type: 'skill', name: 'x' }], seen, 2000);
  assert.deepStrictEqual(later.map(i => !!i.isNew), [false, true]);
  assert.deepStrictEqual(later.map(i => i.addedAt), [0, 2000]);
  assert.ok(b.markNew([{ type: 'builtin', name: 'q', addedAt: 5000 }], seen, 6000)[0].isNew, 'release date wins over first-seen');

  const md = ['# Changelog', '', '## 2.1.9', '- Fixed `/plans` and `/btw` scroll', '## 2.1.5', '- Added `/btw` for side questions', '## 1.0.0', '- `/plan` mode', ''].join(String.fromCharCode(10));
  assert.deepStrictEqual([...b.parseChangelog(md, ['btw', 'plan', 'goal'])], [['btw', '2.1.5'], ['plan', '1.0.0']]);
  const st = b.stampSince([{ name: 'btw' }, { name: 'goal' }], md, { '2.1.5': '2026-03-18T21:34:08Z' });
  assert.deepStrictEqual(st, [{ name: 'btw', since: '2.1.5', addedAt: Date.parse('2026-03-18T21:34:08Z') }, { name: 'goal' }]);
  assert.ok(!b.markNew([{ type: 'skill', name: 'x' }], seen, 2000 + 8 * 864e5)[0].isNew, 'new for a week');
  // a repo's skills aren't "new" the first time the picker opens in that repo; one added later is
  const s2 = { 'builtin:clear': 0 };
  assert.ok(!b.markNew([{ type: 'skill', name: 'r', origin: 'repo' }], s2, 9000, 'C:/a')[0].isNew);
  assert.ok(b.markNew([{ type: 'skill', name: 'r2', origin: 'repo' }], s2, 9000, 'C:/a')[0].isNew);
  // hand-kept commands survive only while the binary still names them
  const sc = new Map(Array.from({ length: 12 }, (_, i) => ['c' + i, 'd'])); sc.names = new Set(['model']);
  const fb2 = [{ name: 'model', desc: 'm' }, { name: 'vim', desc: 'v' }];
  assert.deepStrictEqual(b.mergeBuiltins(sc, fb2).filter(x => !x.name.startsWith('c')).map(x => x.name), ['model']);
  console.log('builtins-scan ok');
});
