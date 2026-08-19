// Run: node prompt-copy.test.js
const assert = require('assert');
const { boxInner, readPromptText } = require('./prompt-copy');

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

console.log('prompt-copy: ok');
