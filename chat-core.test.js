const test = require('node:test');
const assert = require('node:assert');
const { toolView, groupSummary, lineDiff, matchFiles } = require('./chat-core');

test('a call reads as verb + target, present tense while it runs', () => {
  assert.deepStrictEqual(toolView({ name: 'Bash', args: { command: 'git status' } }), { kind: 'cmd', verb: 'Ran', target: 'git status', mono: true });
  // the agent's own one-line description reads better than a long command; the command shows when opened
  assert.deepStrictEqual(toolView({ name: 'Bash', args: { command: 'D=/c/x; nice -n 19 npx electron run.js', description: 'Render screenshots' } }), { kind: 'cmd', verb: 'Ran', target: 'Render screenshots', mono: false });
  assert.strictEqual(toolView({ name: 'Edit', args: { file_path: 'C:\\w\\main.js' } }, true).verb, 'Editing');
  assert.strictEqual(toolView({ name: 'Edit', args: { file_path: 'C:\\w\\main.js' } }).target, 'main.js');
  assert.strictEqual(toolView({ name: 'mcp__clickup__clickup_get_task', args: {} }).verb, 'clickup get task');
});

test('a run of calls sums up like Claude\'s apps', () => {
  const evs = [{ name: 'Bash', args: {} }, { name: 'Bash', args: {} }, { name: 'Read', args: { file_path: 'a.js' } }, { name: 'Read', args: { file_path: 'b.js' } }, { name: 'Edit', args: { file_path: 'a.js' } }];
  assert.strictEqual(groupSummary(evs), 'Ran 2 commands, read 2 files, edited a.js');
});

test('@file matches rank name prefix, then name, then path, then fuzzy', () => {
  const files = ['src/deep/chat-ui.js', 'chat-ui.js', 'docs/chat.md', 'src/uichat.ts', 'main.js'];
  assert.deepStrictEqual(matchFiles(files, 'chat'), ['chat-ui.js', 'docs/chat.md', 'src/deep/chat-ui.js', 'src/uichat.ts']);
  assert.deepStrictEqual(matchFiles(files, 'mjs'), ['main.js']);
  assert.strictEqual(matchFiles(files, '').length, 5);
});

test('a unified git diff splits into files with their rows and counts', () => {
  const d = 'diff --git a/x.js b/x.js\nindex 1..2 100644\n--- a/x.js\n+++ b/x.js\n@@ -1,2 +1,2 @@\n a\n-b\n+B\n@@ -9 +9,2 @@\n z\n+y\ndiff --git a/n.md b/n.md\nnew file mode 100644\n--- /dev/null\n+++ b/n.md\n@@ -0,0 +1 @@\n+hi\n';
  const [x, n] = require('./chat-core').parseUnified(d);
  assert.deepStrictEqual([x.file, x.add, x.del, x.rows.map(r => r.t).join('')], ['x.js', 2, 1, '… -+… +']);
  assert.deepStrictEqual(x.rows.map(r => [r.o ?? null, r.n ?? null]), [[null, 1], [1, 1], [2, null], [null, 2], [null, 9], [9, 9], [null, 10]]); // old / new line numbers
  assert.strictEqual(x.rows[0].s, '@@ -1,2 +1,2 @@'); // the hunk's range
  assert.deepStrictEqual([n.file, n.created, n.add], ['n.md', true, 1]);
});

test('file:line references are found, times and URLs are not', () => {
  const { fileRefs } = require('./chat-core');
  assert.deepStrictEqual(fileRefs('see main.js:2032 and `src/a.ts:12:5`.').map(r => [r.file, r.line]), [['main.js', 2032], ['src/a.ts', 12]]);
  assert.deepStrictEqual(fileRefs('at 12:30, http://x.com:80 or v1.2:3'), []);
  assert.deepStrictEqual(fileRefs('C:\\w\\x.py:7').map(r => r.file), ['C:\\w\\x.py']);
});

test('lineDiff marks changed lines and folds unchanged runs', () => {
  const old = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'].join('\n');
  const d = lineDiff(old, old.replace('e', 'E'));
  assert.strictEqual(d.add, 1); assert.strictEqual(d.del, 1);
  assert.deepStrictEqual(d.rows.map(r => r.t).join(''), '    -+   …');
  assert.deepStrictEqual(lineDiff('', 'x\ny'), { rows: [{ t: '+', s: 'x' }, { t: '+', s: 'y' }], add: 2, del: 0 });
});

test('an absolute path in inline code becomes a file chip; relative names and prose stay code', () => {
  const { pathRef } = require('./chat-core');
  assert.deepStrictEqual(pathRef('C:\\Users\\y\\scratchpad\\chatshot\\live-0.png'), { file: 'C:\\Users\\y\\scratchpad\\chatshot\\live-0.png', name: 'live-0.png', dir: 'chatshot', img: true });
  assert.deepStrictEqual(pathRef('~/.claude/x.md'), { file: '~/.claude/x.md', name: 'x.md', dir: '.claude', img: false });
  assert.strictEqual(pathRef('chat-ui.js'), null);
  assert.strictEqual(pathRef('npm run build'), null);
  assert.strictEqual(pathRef('C:\\Work\\overlord'), null); // a folder: no extension
});

test('dictated words go in at the caret with a space either side only where needed', () => {
  const { dictJoin } = require('./chat-core');
  assert.strictEqual(dictJoin('', 'Hello world', ''), 'Hello world');
  assert.strictEqual(dictJoin('fix', 'the bug', ''), 'fix the bug');
  assert.strictEqual(dictJoin('fix ', 'the bug', 'now'), 'fix the bug now');
  assert.strictEqual(dictJoin('line\n', 'next', ' end'), 'line\nnext end');
  assert.strictEqual(dictJoin('abc', '', 'def'), 'abcdef');
  // the recognizer capitalises every phrase: mid-sentence it reads lower case, after a full stop it stays
  assert.strictEqual(dictJoin('Please', 'Fix the bug', ''), 'Please fix the bug');
  assert.strictEqual(dictJoin('Done.', 'Next one', ''), 'Done. Next one');
  assert.strictEqual(dictJoin('so', 'I think', ''), 'so I think');
  assert.strictEqual(dictJoin('check', 'API keys', ''), 'check API keys');
});

test('liveReply: the reply being written, read off the CLI screen above its spinner', () => {
  const { liveReply } = require('./chat-core');
  const screen = [
    '> fix the scroll',
    '',
    '● Bash(git status)',
    '  ⎿  On branch master',
    '',
    '● The chat lags because Claude writes a block to the',
    '  transcript only once it is complete.',
    '',
    '✻ Cogitating… (12s · ↓ 300 tokens · esc to interrupt)',
    '',
    '────────────────',
    '> ',
  ];
  assert.strictEqual(liveReply(screen), 'The chat lags because Claude writes a block to the\ntranscript only once it is complete.');
  // the newest bullet is a tool call: nothing to preview
  assert.strictEqual(liveReply(screen.slice(0, 5).concat(screen.slice(8))), '');
  // no spinner: the turn is over, the transcript has it all
  assert.strictEqual(liveReply(screen.slice(0, 8)), '');
  // a reply from an earlier turn above the latest prompt is not this turn's
  assert.strictEqual(liveReply(['● old answer', '', '> next question', '', '✶ Pondering… (2s · esc to interrupt)']), '');
});

test('screenDialog: a CLI dialog (rewind, /config, /model…) is up when its "Esc to …" footer is at the bottom', () => {
  const { screenDialog } = require('./chat-core');
  assert.strictEqual(screenDialog(['Rewind', '❯ fix the scroll', '  add a test', '', 'Enter to continue · Esc to exit', '']), true);
  assert.strictEqual(screenDialog(['Select model', '❯ 1. Opus', '', 'Enter to confirm · Esc to cancel']), true);
  // the normal prompt: a reply that mentions the footer text above the box doesn't count
  assert.strictEqual(screenDialog(['● Press Esc to cancel the dialog.', '', '────', '> ', '────', '  ⏵⏵ bypass permissions on (shift+tab to cycle)']), false);
  assert.strictEqual(screenDialog(['✻ Cogitating… (3s · esc to interrupt)', '────', '> ', '────']), false);
});

test('in a hunk, a removed "-- x" or an added "++i" is a change, not a header', () => {
  const [f] = require('./chat-core').parseUnified('diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n--- old rule\n+++i\n same');
  assert.deepStrictEqual([f.add, f.del, f.rows.map(r => r.t).join('')], [1, 1, '…-+ ']);
});

test('a run of only Artifact calls still has a summary', () => {
  assert.strictEqual(groupSummary([{ type: 'tool', name: 'Artifact', args: { action: 'list' } }, { type: 'tool', name: 'Artifact', args: { action: 'read' } }]), 'Used 2 Artifacts calls');
});
