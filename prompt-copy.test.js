// Run: node prompt-copy.test.js
const assert = require('assert');
const { boxInner, readPromptText, eraseSelSeq } = require('./prompt-copy');

// Claude's prompt box, cursor on the input line
const box = [
  'some output above',
  '╭────────────────────────────╮',
  '│ > fix the login bug        │',
  '╰────────────────────────────╯',
];
assert.strictEqual(readPromptText(box, 2), 'fix the login bug');

// multi-line input: all rows of the box, marker stripped only where present
const multi = [
  '╭──────────────╮',
  '│ > line one   │',
  '│   line two   │',
  '╰──────────────╯',
];
assert.strictEqual(readPromptText(multi, 2), 'line one\nline two');

// wrapped row that ran to the edge — right border trimmed away by the renderer
assert.strictEqual(boxInner('│ > text with no right edge'), '> text with no right edge');
assert.strictEqual(readPromptText(['│ > wrapped text'], 0), 'wrapped text');

// box borders themselves are not input rows
assert.strictEqual(boxInner('╭────╮'), null);
assert.strictEqual(boxInner('plain output'), null);

// no box at all: the cursor line, minus the shell prompt char
assert.strictEqual(readPromptText(['$ npm run dist'], 0), 'npm run dist');
assert.strictEqual(readPromptText(['❯ git status'], 0), 'git status');

// empty prompt copies nothing (caller skips the clipboard write)
assert.strictEqual(readPromptText(['│ >                 │'], 0), '');
assert.strictEqual(readPromptText([], 0), '');
assert.strictEqual(readPromptText(['out'], 9), '');

// Mouse selection on the prompt row → bytes that delete it: arrows to its right end, then backspaces.
// Columns are 0-based, end exclusive (what xterm's getSelectionPosition gives).
const row = '> hello world';            // typed text runs from col 2 to col 13
const L = '[D', R = '[C', BS = '';
// cursor at the end (13), "world" selected (8..13): no move, 5 backspaces
assert.strictEqual(eraseSelSeq(row, 8, 13, 13, false), BS.repeat(5));
// cursor at the end, "hello" selected (2..7): left 6 to col 7, then 5 backspaces
assert.strictEqual(eraseSelSeq(row, 2, 7, 13, false), L.repeat(6) + BS.repeat(5));
// cursor at the start of the text (2), "world" selected: right 11, then 5 backspaces
assert.strictEqual(eraseSelSeq(row, 8, 13, 2, false), R.repeat(11) + BS.repeat(5));
// selection over the "> " marker and past the text's end is clamped to the typed text
assert.strictEqual(eraseSelSeq(row, 0, 40, 13, false), BS.repeat(11));
// application cursor-key mode sends ESC O x arrows
assert.strictEqual(eraseSelSeq(row, 2, 7, 13, true), 'OD'.repeat(6) + BS.repeat(5));
// nothing of the typed text selected → null (let the key through)
assert.strictEqual(eraseSelSeq(row, 0, 2, 13, false), null);
assert.strictEqual(eraseSelSeq(row, 20, 30, 13, false), null);

console.log('prompt-copy: ok');
