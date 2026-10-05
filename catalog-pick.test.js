// Run: node catalog-pick.test.js
const assert = require('assert');
const { fuzzyScore, pickItems, makeSlashGate } = require('./catalog-pick');

// fuzzy: subsequence required, case-insensitive, match positions returned
assert.strictEqual(fuzzyScore('xyz', 'fix-bug'), null);
assert.deepStrictEqual(fuzzyScore('fbug', 'fix-bug').pos, [0, 4, 5, 6]);
assert.ok(fuzzyScore('FB', 'fix-bug'));
// consecutive + word-start beat scattered
assert.ok(fuzzyScore('bug', 'fix-bug').score > fuzzyScore('bug', 'brainstorming-upgrade').score);
assert.ok(fuzzyScore('sd', 'systematic-debugging').score > fuzzyScore('sd', 'ssssd').score);
// empty query matches everything with score 0
assert.deepStrictEqual(fuzzyScore('', 'abc'), { score: 0, pos: [] });

const items = [
  { type: 'skill', name: 'fix-bug', desc: 'Read a ClickUp bug', origin: 'pc' },
  { type: 'skill', name: 'systematic-debugging', desc: 'any bug', origin: 'plugin' },
  { type: 'command', name: 'release', desc: 'cut', origin: 'repo' },
  { type: 'builtin', name: 'compact', desc: 'compact chat', origin: 'builtin' },
];
// type filter
assert.deepStrictEqual(pickItems(items, 'command', '').map(i => i.name), ['release']);
// no type: all, ranked by score; name match beats desc-only match
const r = pickItems(items, null, 'bug');
assert.strictEqual(r[0].name, 'fix-bug');
assert.ok(r.some(i => i.name === 'systematic-debugging'));
assert.ok(!r.some(i => i.name === 'release'));
// description matches are literal words, not scattered letters — fuzzy over long text matches everything
assert.ok(!pickItems(items, null, 'rcb').some(i => i.name === 'fix-bug'), 'no fuzzy over description');
assert.ok(pickItems(items, null, 'clickup').some(i => i.name === 'fix-bug'), 'word in description matches');
// empty query keeps origin order: repo, pc, plugin, builtin
assert.deepStrictEqual(pickItems(items, null, '').map(i => i.origin), ['repo', 'pc', 'plugin', 'builtin']);

// slash gate: "//" within the window opens, a lone "/" is flushed late, other data passes
let sent = [], opened = 0, timers = [];
const fakeTimer = { set: (fn) => { timers.push(fn); return timers.length; }, clear: (h) => { timers[h - 1] = null; } };
const gate = makeSlashGate({ send: d => sent.push(d), open: () => opened++, timer: fakeTimer });
gate('/'); assert.deepStrictEqual(sent, []);
gate('/'); assert.strictEqual(opened, 1); assert.deepStrictEqual(sent, []);
gate('/'); timers.at(-1)(); assert.deepStrictEqual(sent, ['/'], 'lone slash flushed after timeout');
sent = [];
gate('/'); gate('a'); assert.deepStrictEqual(sent, ['/', 'a'], 'next key flushes held slash first');
sent = [];
gate('https://x'); assert.deepStrictEqual(sent, ['https://x'], 'pasted text untouched');
// default timer: setTimeout must not be called as a method — browsers throw "Illegal invocation"
{
  const real = global.setTimeout;
  global.setTimeout = function (fn, ms) { if (this !== undefined && this !== globalThis) throw new TypeError('Illegal invocation'); return real(fn, ms); };
  try { const g = makeSlashGate({ send: () => {}, open: () => {} }); g('/'); g('/'); } finally { global.setTimeout = real; }
}
console.log('catalog-pick ok');
