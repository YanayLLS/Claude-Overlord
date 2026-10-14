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
  assert.ok(!b.markNew([{ type: 'skill', name: 'x' }], seen, 2000 + 8 * 864e5)[0].isNew, 'new for a week');
  console.log('builtins-scan ok');
});
