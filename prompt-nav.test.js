// Run: node prompt-nav.test.js
const assert = require('assert');
const { promptRows, nextNavIdx } = require('./prompt-nav');

// Claude Code v2 echoes each submitted prompt into scrollback as "❯ text".
// The live input line uses the same marker, so it must NOT count as a prompt —
// otherwise the first jump lands on the bottom row and looks like a no-op.
const rows = [
  'some output',
  '❯ first prompt',
  'tool output',
  '❯ second prompt',
  'more output',
  '',
  '❯ what I am typing now',   // live input line, inside the current screen
  '  ? for shortcuts',
];
const baseY = 5; // current screen starts here
assert.deepStrictEqual(promptRows(rows, baseY), [1, 3]);

// Old bordered-box style still recognised
assert.deepStrictEqual(promptRows(['│ > boxed prompt │', 'out'], 1), [0]);

// Navigation: total=2 prompts, index 2 is the virtual "bottom" entry.
assert.strictEqual(nextNavIdx(2, -1, 2), 1);   // from bottom → last prompt
assert.strictEqual(nextNavIdx(1, -1, 2), 0);
assert.strictEqual(nextNavIdx(0, -1, 2), 0);   // clamp, never a dead click
assert.strictEqual(nextNavIdx(0, 1, 2), 1);
assert.strictEqual(nextNavIdx(2, 1, 2), 2);    // already at bottom → stay
// Out-of-range index (seeded from the JSONL prompt list, a different count)
// snaps to the bottom instead of freezing the buttons.
assert.strictEqual(nextNavIdx(29, -1, 2), 1);
assert.strictEqual(nextNavIdx(-1, 1, 2), 2);

console.log('prompt-nav: all assertions passed');

// Renderer scripts share one global lexical scope: a `const` name declared by two
// of them is a SyntaxError that silently kills the second file (this exact bug —
// prompt-copy.js and prompt-nav.js both had `const MARKER`, so promptRows was
// never defined and every jump click did nothing). Parse them the way the page does.
const fs = require('fs');
const html = fs.readFileSync(__dirname + '/index.html', 'utf8');
const srcs = [...html.matchAll(/<script src="\.\/([^"]+)"><\/script>/g)].map(m => m[1])
  .filter(f => f !== 'xterm-bundle.js'); // bundled, not ours
const combined = srcs.map(f => fs.readFileSync(__dirname + '/' + f, 'utf8')).join('\n');
new Function(combined); // throws on any duplicate top-level declaration
console.log('renderer scripts (' + srcs.join(', ') + ') share no clashing globals');
