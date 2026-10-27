const test = require('node:test');
const assert = require('node:assert');
const { toolView, groupSummary, lineDiff, matchFiles } = require('./chat-core');

test('a call reads as verb + target, present tense while it runs', () => {
  assert.deepStrictEqual(toolView({ name: 'Bash', args: { command: 'git status' } }), { kind: 'cmd', verb: 'Ran', target: 'git status', mono: true });
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
  assert.deepStrictEqual(x.rows.map(r => r.n), [1, 1, 2, 2, 9, 9, 10]); // line numbers from the hunk headers
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
