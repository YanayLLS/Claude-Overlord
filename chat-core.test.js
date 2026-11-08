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
  const { relPathRef } = require('./chat-core');
  assert.deepStrictEqual(relPathRef('src/a/x.js'), { file: 'src/a/x.js', name: 'x.js', dir: 'a', img: false });
  assert.strictEqual(relPathRef('..\\docs\\b.md').name, 'b.md');
  for (const s of ['a.cwd', 'chat-ui.js', 'npm run build', 'https://x.com/a.js', 'src/a b.js']) assert.strictEqual(relPathRef(s), null, s);
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

test('a recorded take becomes a 16-bit mono WAV whisper can read', () => {
  const { wavBytes } = require('./chat-core');
  const v = new DataView(wavBytes(new Float32Array([0, 1, -1, 2]), 16000));
  assert.strictEqual(v.byteLength, 44 + 8);
  assert.strictEqual(String.fromCharCode(v.getUint8(0), v.getUint8(1), v.getUint8(2), v.getUint8(3)), 'RIFF');
  assert.strictEqual(v.getUint32(24, true), 16000);
  assert.deepStrictEqual([0, 1, 2, 3].map((i) => v.getInt16(44 + i * 2, true)), [0, 32767, -32768, 32767]); // 2 clamps to 1
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
  // a running call's ● blinks off: its rows are still a call, not part of the text above (it flickered in and out)
  assert.strictEqual(liveReply(['● Checking it on a real card.', '', '  Bash(cd /c/Work)', '  ⎿  Running… (48s)', '', '✻ Sketching… (1m · esc to interrupt)']), '');
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

test("undoing a turn puts each edit back, newest first, or nothing at all", () => {
  const { undoEdits } = require('./chat-core');
  const files = new Map([['a.js', 'let x = 3;\nlet y = 2;\n']]);
  const edits = [{ file: 'a.js', old: 'let x = 1;', new: 'let x = 2;' }, { file: 'a.js', old: 'let x = 2;', new: 'let x = 3;' }];
  assert.strictEqual(undoEdits(files, edits).files.get('a.js'), 'let x = 1;\nlet y = 2;\n');
  assert.match(undoEdits(new Map([['a.js', 'let x = 9;']]), edits).error, /changed since/);
  assert.match(undoEdits(new Map([['a.js', 'y y']]), [{ file: 'a.js', old: 'x', new: 'y' }]).error, /2 times/);
  assert.strictEqual(undoEdits(new Map([['a.js', 'y y']]), [{ file: 'a.js', old: 'x', new: 'y', all: true }]).files.get('a.js'), 'x x');
});

test('terminal text keeps its colours: ANSI codes become spans, other control codes go, diffs are coloured', () => {
  const { termHtml } = require('./chat-core');
  assert.strictEqual(termHtml('\u001b[31m✖ No <tests>\u001b[0m done'), '<span class="ansi-fg1">✖ No &lt;tests&gt;</span> done');
  assert.strictEqual(termHtml('\u001b[1;32mok\u001b[22m still green\u001b[39m plain'), '<span class="ansi-fg2 ansi-b">ok</span><span class="ansi-fg2"> still green</span> plain');
  assert.strictEqual(termHtml('\u001b[38;5;208mo\u001b[38;2;10;20;30mr\u001b[m'), '<span style="color:#ff8700">o</span><span style="color:rgb(10,20,30)">r</span>');
  assert.strictEqual(termHtml('a\u001b[2Kb\u001b]0;title\u0007c\r\nd'), 'abc\nd'); // cursor moves and titles out, CRLF as one line
  assert.strictEqual(termHtml('\u001b[2m  - navigating\u001b[22m'), '<span class="ansi-dim">  - navigating</span>');
  assert.strictEqual(termHtml('@@ -1 +1 @@\n-old\n+new\n same'), '<span class="d-hunk">@@ -1 +1 @@</span>\n<span class="d-del">-old</span>\n<span class="d-add">+new</span>\n same');
  assert.strictEqual(termHtml('- a list item\n+ not a diff'), '- a list item\n+ not a diff'); // no hunk: plain
  assert.strictEqual(termHtml('+ added\n  kept', { diff: true }), '<span class="d-add">+ added</span>\n  kept');
});

test('a terminal buffer pictured as HTML: colours, bold, inverse, wide characters once', () => {
  const { cellsHtml } = require('./chat-core');
  const cell = (ch, o = {}) => ({ getWidth: () => o.w ?? 1, getChars: () => ch, isFgRGB: () => !!o.rgb, isFgPalette: () => o.fg != null, getFgColor: () => o.rgb ?? o.fg ?? 0, isBgRGB: () => false, isBgPalette: () => false, getBgColor: () => 0, isInverse: () => !!o.inv, isBold: () => !!o.b, isDim: () => false, isItalic: () => false, isUnderline: () => false });
  const row = (cells) => ({ length: cells.length, getCell: (x) => cells[x] });
  const buf = { getLine: (y) => [row([cell('>', { fg: 1, b: true }), cell(' '), cell('a<'), cell('中', { w: 2 }), cell('', { w: 0 })]), row([cell('S', { inv: true }), cell('x', { rgb: 0x112233 })])][y] };
  assert.strictEqual(cellsHtml(buf, 0, 2, { red: '#f00', background: '#000', foreground: '#ccc' }),
    '<span style="color:#f00;font-weight:bold">&gt;</span> a&lt;中\n<span style="color:#000;background:#ccc">S</span><span style="color:#112233">x</span>');
});

test('a Claude being auto-resumed after a crash reads like the CLI line', () => {
  const { crashLine } = require('./chat-core');
  assert.strictEqual(crashLine({ crashed: 'resuming', crashCount: 1, crashMax: 3 }), 'Crashed — auto-resuming 1/3…');
  assert.strictEqual(crashLine({ crashed: 'fatal', crashCount: 3, crashMax: 3 }), '');
  assert.strictEqual(crashLine({ crashed: null }), '');
});

test('the mic hint is the project and the code-ish words on screen, newest first, without plain words or links', () => {
  const { dictVocab } = require('./chat-core');
  assert.strictEqual(dictVocab('overlord', 'Fix the bug in chat-composer.js then useState and the API. See https://x.io/a_b now. chat-composer.js again'), 'overlord, chat-composer.js, API, useState');
  assert.strictEqual(dictVocab('', 'nothing here'), '');
});

test('ToolSearch reads as the CLI shows it: Calling <server>, and its folded screen line is no live reply', () => {
  const { liveReply } = require('./chat-core');
  const q = 'select:mcp__overlord-browser__browser_eval,mcp__overlord-browser__browser_screenshot';
  assert.deepStrictEqual(toolView({ name: 'ToolSearch', args: { query: q } }, true), { kind: 'tool', verb: 'Calling', target: 'overlord-browser', mono: false });
  assert.strictEqual(toolView({ name: 'ToolSearch', args: { query: 'select:Monitor' } }).target, 'Monitor');
  const screen = ['> [Image #4]  now i open it', '  ⎿  [Image #4]', '', '● Calling overlord-browser… (ctrl+o to expand)', '', '✽ Processing… (16s · ↓ 753 tokens)'];
  assert.strictEqual(liveReply(screen), '');
  assert.strictEqual(liveReply(['● Read 3 files (ctrl+o to expand)', '✽ Processing… (2s)']), '');
});

test('sketchHtml: a preview drawn in text shows as UI (boxes, buttons, icons, notes, changed lines)', () => {
  const { sketchHtml } = require('./chat-core');
  const h = sketchHtml(['  ┌──────────┐', '  │  ( 🔒 )  │', '+ │ [ Ask Ella ] │  ← mailto', '  └──────────┘', '  Settings › Sharing'].join('\n'));
  assert.match(h, /<div class="sk-box"><div class="sk-row sk-c"><span class="sk-ico">🔒<\/span><\/div>/);
  assert.match(h, /sk-add"><span class="sk-btn">Ask Ella<\/span><\/div><\/div><div class="sk-aside"><div><span class="sk-note">← mailto<\/span>/); // beside its box
  assert.match(sketchHtml('┌──┐\n│ x │\n└──┘\n[◄ Prev]  ( ► replay )  [Next ►]'),/<span class="sk-btn sk-round">► replay<\/span>/);
  assert.match(h, /<div class="sk-row">Settings › Sharing<\/div>/);
  // the CLI's own copy writes the "+" as "-"
  assert.match(sketchHtml('  ┌───┐\n- │ new │\n  └───┘'), /sk-row sk-add">new/);
  // not a sketch: a table or plain text stays text
  assert.strictEqual(sketchHtml('┌─┬─┐\n│a│b│\n├─┼─┤'), '');
  assert.strictEqual(sketchHtml('just words'), '');
});
test('screenDialog: an inline panel above the prompt box (/btw, a skill UI) counts, so the chat shows the terminal', () => {
  const { screenDialog } = require('./chat-core');
  const box = ['──────────────── languages ─', '> ', '────────────────', '  ⏵⏵ bypass permissions on · esc to interrupt'];
  const btw = ['✽ Brewing… (26s · ↓ 1.4k tokens)', '', '  /btw why bump dbschemas', '', '    The backend uses dbschemas as a package.', '', '  ↑/↓ to scroll · c to copy · f to fork · Esc to close', ''];
  assert.strictEqual(screenDialog([...btw, ...box]), true);
  // ...but not a full-screen dialog: a numbered list in the /btw answer isn't a question menu
  assert.strictEqual(screenDialog([...btw.slice(0, 4), '    1. Missing answer', '    2. Wrong state', ...btw.slice(5), ...box], false), false);
  assert.strictEqual(screenDialog(['  Select model', '  1. Opus', '  Esc to cancel'], false), true);
  // the plain working screen: spinner, tip, box: no panel
  assert.strictEqual(screenDialog(['✽ Processing… (16s)', '  ⎿  Tip: Use /theme to change the color theme', '', ...box]), false);
  // "Esc to close" in the conversation above, not right over the box: not a panel
  assert.strictEqual(screenDialog(['● Press Esc to close it', '', '✽ Working… (2s)', '', ...box]), false);
});
test('screenDialog: /btw idle at the bottom of a narrow terminal (its footer wrapped) is a panel, not a full-screen dialog', () => {
  const { screenDialog, screenPanel } = require('./chat-core');
  const rows = ['❯ /btw what is 2+2? answer with a numbered   ', '  list of 3 short points', '  /btw what is 2+2? answer with a numbered l…', '    1. 2+2 = 4.', '    2. Basic addition.', '    I AM DONE', '  ↑/↓ to scroll · c to copy · f to fork · Esc', '  to close'];
  assert.strictEqual(screenPanel(rows), true);
  assert.strictEqual(screenDialog(rows), true);
  assert.strictEqual(screenDialog(rows, false), false); // its numbered list isn't a question menu
});

test('screenPermRows: a sub-agent\'s permission dialog with a long command keeps its header; a question picker is not one', () => {
  const { screenPermRows } = require('./chat-core');
  const cmd = Array.from({ length: 34 }, (_, i) => ' │ line ' + i);
  const rows = ['old reply', '─'.repeat(60), ' Bash command · from the general-purpose agent', ' Run shell command', '╌'.repeat(60), ...cmd, '╌'.repeat(60),
    ' │ Dangerous rm operation not ruled out — the shell may read this command differently than it was parsed', '', ' Do you want to proceed?', ' > 1. Yes', '   2. No', '', ' Esc to cancel · Tab to amend · ctrl+x ctrl+k twice to stop background agents'];
  const p = screenPermRows(rows);
  assert.strictEqual(p.question, 'Do you want to proceed?');
  assert.strictEqual(p.body[0], 'Bash command · from the general-purpose agent');
  assert.ok(p.body.some(r => /Dangerous rm/.test(r)));
  assert.ok(p.body.some(r => /line 33/.test(r)));
  assert.strictEqual(screenPermRows(['─'.repeat(40), ' Do you want to keep it?', ' ❯ 1. Yes', '   2. No', ' Enter to select · ↑/↓ to navigate · Esc to cancel']), null);
  assert.strictEqual(screenPermRows(['just a reply']), null);
});
