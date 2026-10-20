// Self-check for bidi-core pure helpers. Run: node bidi-core.test.js
const assert = require('assert');
const { hasRtl, graphemes, visualOrder, visualGroups, visualCells, looksVisual, toLogical } = require('./bidi-core');

// Which rows are already visual (Claude Code laid them out) and which are logical (code, diffs,
// tool output). Final letters: a word ending in ם/ן/ך/ף/ץ is logical, one starting with them is flipped.
assert.strictEqual(looksVisual('שלום עולם'), false);
assert.strictEqual(looksVisual('םלוע םולש'), true);
assert.strictEqual(looksVisual('const t = "ברוך הבא";'), false);          // no finals: plain-Hebrew code line...
assert.strictEqual(looksVisual('const t = "ברוכים הבאים";'), false);      // ...with finals it is clearly logical
assert.strictEqual(looksVisual('Beneficiaries (םיבטומ)'), true);
assert.strictEqual(looksVisual('.רקובב קורי חופת לוכאל בהוא ינא'), true);   // full stop at the left: RTL paragraph flipped
assert.strictEqual(looksVisual('אני אוהב לאכול תפוח ירוק בבוקר.'), false);
assert.strictEqual(looksVisual('> הז המ יל ריבסת'), true);                   // no clue → Claude's
assert.strictEqual(looksVisual('הקידב'), true);

// Copies back to logical order — each line as Claude Code 2.1.304 actually wrote it to the pty.
assert.strictEqual(toLogical('םלוע םולש'), 'שלום עולם');
assert.strictEqual(toLogical('םיחופת 12 יל שי'), 'יש לי 12 תפוחים');
assert.strictEqual(toLogical('תורדגה / ליפורפ'), 'פרופיל / הגדרות');
assert.strictEqual(toLogical('םיספט → יונימ'), 'מינוי → טפסים');
assert.strictEqual(toLogical('לסב )םימודא('), '(אדומים) בסל');             // Claude Code does not mirror brackets
assert.strictEqual(toLogical('say םולש now'), 'say שלום now');
assert.strictEqual(toLogical('.םלוע ,םולש'), 'שלום, עולם.');
assert.strictEqual(toLogical('והד abc גבא'), 'אבג abc דהו');
assert.strictEqual(toLogical('Beneficiaries (םיבטומ)'), 'Beneficiaries (מוטבים)');
// Logical lines and Latin-only text pass through; lines are handled one by one.
assert.strictEqual(toLogical('שלום עולם'), 'שלום עולם');
assert.strictEqual(toLogical('hello\nםלוע םולש\nconst t = "ברוכים הבאים";'), 'hello\nשלום עולם\nconst t = "ברוכים הבאים";');

// Detection: only rows holding Hebrew/Arabic are worth touching.
assert.strictEqual(hasRtl('hello 123'), false);
assert.strictEqual(hasRtl('say שלום'), true);
assert.strictEqual(hasRtl('مرحبا'), true);

// Helper: the units of a string rendered in visual order, as a string.
const vis = (s) => { const u = graphemes(s); return visualOrder(u).map(i => u[i]).join(''); };

// Pure LTR: untouched.
assert.strictEqual(vis('abc 12'), 'abc 12');

// One Hebrew word: letters reversed (logical אבג shows as גבא on screen, read right-to-left).
assert.strictEqual(vis('אבג'), 'גבא');

// Two Hebrew words: the whole phrase flips — word order and letters.
assert.strictEqual(vis('שלום עולם'), 'םלוע םולש');

// Hebrew inside Latin text: only the Hebrew run flips; the surrounding spaces stay.
assert.strictEqual(vis('say שלום now'), 'say םולש now');

// Trailing/leading neutrals outside the run keep their place (LTR paragraph).
assert.strictEqual(vis('שלום  '), 'םולש  ');
assert.strictEqual(vis('  שלום'), '  םולש');

// A number inside a Hebrew run keeps its digits in order, but sits in the run's RTL flow.
assert.strictEqual(vis('יש 12 תפוחים'), 'םיחופת 12 שי');

// Decimal / thousands separators between digits stay with the number.
assert.strictEqual(vis('מחיר 3.5 שח'), 'חש 3.5 ריחמ');

// A number after a Hebrew word belongs to its flow (as browsers show it): it lands left of the word.
assert.strictEqual(vis('גרסה 12'), '12 הסרג');
// A number before the first Hebrew word is LTR text: it stays left, the run flips after it.
assert.strictEqual(vis('12 תפוחים'), '12 םיחופת');
// Latin text after the number ends the flow: Hebrew + number flip together, the rest stays.
assert.strictEqual(vis('say שלום 12 now'), 'say 12 םולש now');

// Punctuation between two Hebrew words is part of the run; a trailing one is not.
assert.strictEqual(vis('כן, לא.'), 'אל ,ןכ.');

// Brackets inside an RTL run are mirrored so they still enclose visually.
const m = visualGroups(graphemes('(אב)').map(c => ({ text: c, key: 0 })));
assert.strictEqual(m.map(g => g.text).join(''), '(בא)');
// ...but brackets around Latin text are not.
assert.strictEqual(visualGroups(graphemes('(ab)').map(c => ({ text: c, key: 0 })))[0].text, '(ab)');

// Combining marks (niqqud) stay glued to their base letter: graphemes() makes one unit of them.
assert.deepStrictEqual(graphemes('a שׁב'), ['a', ' ', 'שׁ', 'ב']);
assert.deepStrictEqual(graphemes('x́y'), ['x́', 'y']);
assert.strictEqual(vis('a שׁב'), 'a בשׁ');

// Grouping: consecutive units from the same source span stay one group, in visual order.
const units = graphemes('ab שלום').map((c, i) => ({ text: c, key: i < 3 ? 'A' : 'B' }));
assert.deepStrictEqual(visualGroups(units), [{ key: 'A', text: 'ab ' }, { key: 'B', text: 'םולש' }]);

// Grouping splits where the source span changes mid-run (e.g. a colored letter).
const units2 = graphemes('אבג').map((c, i) => ({ text: c, key: i === 1 ? 'hi' : 'lo' }));
assert.deepStrictEqual(visualGroups(units2), [{ key: 'lo', text: 'ג' }, { key: 'hi', text: 'ב' }, { key: 'lo', text: 'א' }]);

// Grouping of a pure-LTR row is a no-op merge per source span.
assert.deepStrictEqual(visualGroups([{ text: 'x', key: 1 }, { text: 'y', key: 1 }]), [{ key: 1, text: 'xy' }]);

// Typical Claude Code prompt row: a prompt glyph, then a Hebrew sentence being typed.
assert.strictEqual(vis('> תסביר לי מה זה'), '> הז המ יל ריבסת');

// Cursor: the blank cell under the caret right after a Hebrew word joins the run, so the caret
// shows at the run's left end — where the next typed letter appears. Marked here as "_".
const curVis = (s, cursor) => { const u = graphemes(s); return visualOrder(u, cursor).map(i => u[i] === ' ' && i === cursor ? '_' : u[i]).join(''); };
assert.strictEqual(curVis('> שלום ', 6), '> _םולש');
// A blank cursor cell after Latin text, or a non-blank one, stays where it is.
assert.strictEqual(curVis('> abc ', 5), '> abc_');
assert.strictEqual(curVis('> שלום', 5), '> םולש');
// A box border after the Hebrew is a plain neutral: it stays at the line's right end (no last-strong guessing,
// which would drag table borders and box edges into the run).
assert.strictEqual(vis('│ שלום    │'), '│ םולש    │');
assert.strictEqual(vis('שלום.'), 'םולש.');

// Mouse mapping: visual column → buffer column, plus whether that cell is in a flipped run.
const cellsOf = (s) => graphemes(s).map(t => ({ text: t, width: 1 }));
// Latin row: identity.
assert.deepStrictEqual(visualCells(cellsOf('abc')), { v2l: [0, 1, 2], rtl: [false, false, false] });
// "ab שלום" occupies columns 0-6; on screen the Hebrew shows as ם ו ל ש at columns 3-6, i.e. buffer 6,5,4,3.
assert.deepStrictEqual(visualCells(cellsOf('ab שלום')), { v2l: [0, 1, 2, 6, 5, 4, 3], rtl: [false, false, false, true, true, true, true] });
// A wide character (2 columns) before the Hebrew shifts the buffer columns by two.
assert.deepStrictEqual(visualCells([{ text: '漢', width: 2 }, { text: ' ', width: 1 }, { text: 'א', width: 1 }, { text: 'ב', width: 1 }]), { v2l: [0, 1, 2, 4, 3], rtl: [false, false, false, true, true] });
// Digits inside a Hebrew run keep their left-to-right order and are not flipped cells.
const d = visualCells(cellsOf('א 12 ב'));
assert.deepStrictEqual(d.v2l, [5, 4, 2, 3, 1, 0]);
assert.deepStrictEqual(d.rtl, [true, true, false, false, true, true]);
// The cursor cell follows the same rule as the DOM ordering, so mouse and pixels agree.
assert.deepStrictEqual(visualCells(cellsOf('אב '), 2).v2l, [2, 1, 0]);

console.log('bidi-core ok');
