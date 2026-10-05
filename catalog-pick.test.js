// Run: node catalog-pick.test.js
const assert = require('assert');
const { fuzzyScore, pickItems, makeSlashGate, promptTop, parseHotkey, chordMatch, hotkeyFromEvent } = require('./catalog-pick');

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
// promptTop: the ─── divider above Claude's live "> " row, searched bottom-up; -1 when there's no prompt
const scr = ['● Done.', '> an old prompt in the transcript', '', '────────────', '> fix it', '────────────', '  ⏵⏵ bypass permissions on'];
assert.strictEqual(promptTop(scr), 3);
assert.strictEqual(promptTop(['────', '❯ ']), 0, 'empty prompt, ❯ marker');
assert.strictEqual(promptTop(['> quoted text', 'more output']), -1, 'no divider above → not the input');
assert.strictEqual(promptTop(['$ ls', 'a b']), -1);
// default timer: setTimeout must not be called as a method — browsers throw "Illegal invocation"
{
  const real = global.setTimeout;
  global.setTimeout = function (fn, ms) { if (this !== undefined && this !== globalThis) throw new TypeError('Illegal invocation'); return real(fn, ms); };
  try { const g = makeSlashGate({ send: () => {}, open: () => {} }); g('/'); g('/'); } finally { global.setTimeout = real; }
}
// configurable sequence: seq() picks the two typed chars; '' turns the gate off (everything passes)
{
  let sent = [], opened = 0, timers = [], cur = ';;';
  const t = { set: (fn) => { timers.push(fn); return timers.length; }, clear: (h) => { timers[h - 1] = null; } };
  const g = makeSlashGate({ send: d => sent.push(d), open: () => opened++, timer: t, seq: () => cur });
  g('/'); assert.deepStrictEqual(sent, ['/'], '/ passes untouched when the hotkey is ;;');
  g(';'); g(';'); assert.strictEqual(opened, 1);
  g(';'); g('x'); assert.deepStrictEqual(sent, ['/', ';', 'x']);
  cur = ''; sent = []; g('/'); g('/'); assert.deepStrictEqual(sent, ['/', '/'], 'disabled: nothing held');
  cur = 'Ctrl+K'; sent = []; g('/'); assert.deepStrictEqual(sent, ['/'], 'chord hotkey: typing is never held');
}

// hotkeys: two typed chars, or a modifier chord
assert.deepStrictEqual(parseHotkey('//'), { seq: '//' });
assert.deepStrictEqual(parseHotkey('ctrl+k'), { chord: { ctrl: true, alt: false, shift: false, meta: false, key: 'k' } });
assert.deepStrictEqual(parseHotkey('Ctrl+Shift+Space').chord.key, ' ');
assert.strictEqual(parseHotkey(''), null);
assert.strictEqual(parseHotkey('abc'), null, 'three plain chars is not a hotkey');
assert.strictEqual(parseHotkey('K'), null, 'a plain key alone would eat typing');
const ev = (o) => ({ ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...o });
assert.ok(chordMatch(ev({ key: 'K', ctrlKey: true }), parseHotkey('Ctrl+K')), 'case-insensitive key');
assert.ok(!chordMatch(ev({ key: 'k', ctrlKey: true, shiftKey: true }), parseHotkey('Ctrl+K')), 'extra modifier → no');
assert.ok(!chordMatch(ev({ key: 'k', ctrlKey: true }), parseHotkey('//')));
assert.strictEqual(hotkeyFromEvent(ev({ key: 'p', altKey: true })), 'Alt+P');
assert.strictEqual(hotkeyFromEvent(ev({ key: ' ', ctrlKey: true, shiftKey: true })), 'Ctrl+Shift+Space');
assert.strictEqual(hotkeyFromEvent(ev({ key: 'Control', ctrlKey: true })), null, 'modifier alone');
assert.strictEqual(hotkeyFromEvent(ev({ key: 'a' })), null, 'no modifier');
console.log('catalog-pick ok');
