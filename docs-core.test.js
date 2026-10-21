const { test } = require('node:test');
const assert = require('node:assert');
const { mdArgs, joinPath, normalizePath, docTitle, splitFrontMatter, slug, classifyHref, assetUrl, withDoc, withoutDoc, nextAfterClose, toggleTask } = require('./docs-core');

test('mdArgs: keeps only markdown args, resolved against cwd, ignoring electron argv and flags', () => {
  assert.deepStrictEqual(mdArgs(['C:\\app\\Overlord.exe', 'C:\\docs\\a.md'], 'C:\\x'), ['C:\\docs\\a.md']);
  assert.deepStrictEqual(mdArgs(['electron.exe', '.', '--inspect', 'notes.MD', 'sub\\b.markdown', 'c.txt'], 'D:\\Work'), ['D:\\Work\\notes.MD', 'D:\\Work\\sub\\b.markdown']);
  assert.deepStrictEqual(mdArgs(['"C:\\Users\\me\\My Docs\\plan.md"'], 'C:\\'), ['C:\\Users\\me\\My Docs\\plan.md']);
  assert.deepStrictEqual(mdArgs(['/usr/bin/app', 'readme.md'], '/home/u'), ['/home/u/readme.md']);
  assert.deepStrictEqual(mdArgs([], 'C:\\'), []);
  assert.deepStrictEqual(mdArgs(undefined, 'C:\\'), []);
});

test('joinPath / normalizePath fold dots and keep the separator style', () => {
  assert.strictEqual(joinPath('C:\\a\\b', '..\\c\\d.md'), 'C:\\a\\c\\d.md');
  assert.strictEqual(joinPath('C:\\a\\b', './c.md'), 'C:\\a\\b\\c.md');
  assert.strictEqual(joinPath('C:/a/b', 'c.md'), 'C:\\a\\b\\c.md');
  assert.strictEqual(joinPath('/home/u/docs', '../x.md'), '/home/u/x.md');
  assert.strictEqual(joinPath('/home/u', 'C:\\z.md'), 'C:\\z.md');
  assert.strictEqual(normalizePath('C:/Users/me//Documents/./a.md'), 'C:\\Users\\me\\Documents\\a.md');
  assert.strictEqual(normalizePath('/a/../../b'), '/b');
});

test('docTitle: first H1, setext title, else file name', () => {
  assert.strictEqual(docTitle('# Hello *World*\n\ntext', 'C:\\x\\a.md'), 'Hello World');
  assert.strictEqual(docTitle('intro\n\nTitle Here\n=====\n', 'C:\\x\\a.md'), 'Title Here');
  assert.strictEqual(docTitle('## only h2\n', 'C:\\x\\notes.md'), 'notes');
  assert.strictEqual(docTitle('---\ntitle: fm\n---\n# Real\n', '/a/b.md'), 'Real');
  assert.strictEqual(docTitle('', ''), 'Untitled');
  assert.strictEqual(docTitle('#notaheading\n', 'x.md'), 'x');
});

test('splitFrontMatter: yaml block becomes pairs, body is the rest', () => {
  const r = splitFrontMatter('---\ntitle: "A doc"\ntags:\n  - one\n  - two\n---\n# Body\n');
  assert.deepStrictEqual(r.meta, [['title', 'A doc'], ['tags', 'one two']]);
  assert.strictEqual(r.body, '# Body\n');
  assert.deepStrictEqual(splitFrontMatter('# No fm\n---\n'), { meta: null, body: '# No fm\n---\n' });
  assert.deepStrictEqual(splitFrontMatter('---\n---\nx'), { meta: null, body: 'x' });
});

test('slug: github heading ids, unique within a doc', () => {
  const seen = new Map();
  assert.strictEqual(slug('Hello, World!', seen), 'hello-world');
  assert.strictEqual(slug('Hello World', seen), 'hello-world-1');
  assert.strictEqual(slug('  שלום עולם ', seen), 'שלום-עולם');
  assert.strictEqual(slug('<code>x</code> y', seen), 'x-y');
  assert.strictEqual(slug('!!!', seen), 'section');
});

test('classifyHref: anchors, the web, sibling docs, other files', () => {
  const d = 'C:\\docs\\guide\\a.md';
  assert.deepStrictEqual(classifyHref('#setup', d), { kind: 'anchor', id: 'setup' });
  assert.deepStrictEqual(classifyHref('https://x.y/z', d), { kind: 'external', url: 'https://x.y/z' });
  assert.deepStrictEqual(classifyHref('mailto:a@b.c', d), { kind: 'external', url: 'mailto:a@b.c' });
  assert.deepStrictEqual(classifyHref('../other.md#top', d), { kind: 'doc', path: 'C:\\docs\\other.md', hash: 'top' });
  assert.deepStrictEqual(classifyHref('sub/My%20Doc.md', d), { kind: 'doc', path: 'C:\\docs\\guide\\sub\\My Doc.md', hash: '' });
  assert.deepStrictEqual(classifyHref('D:\\abs\\x.md', d), { kind: 'doc', path: 'D:\\abs\\x.md', hash: '' });
  assert.deepStrictEqual(classifyHref('file:///C:/abs/y.md', d), { kind: 'doc', path: 'C:\\abs\\y.md', hash: '' });
  assert.deepStrictEqual(classifyHref('img/pic.png', d), { kind: 'file', path: 'C:\\docs\\guide\\img\\pic.png' });
  assert.deepStrictEqual(classifyHref('', d), { kind: 'none' });
  assert.deepStrictEqual(classifyHref('vscode://x', d), { kind: 'external', url: 'vscode://x' });
});

test('assetUrl: relative images become file URLs beside the doc; absolute urls untouched', () => {
  assert.strictEqual(assetUrl('img/a b.png', 'C:\\docs\\a.md'), 'file:///C:/docs/img/a%20b.png');
  assert.strictEqual(assetUrl('../x#1.png', '/home/u/d/a.md'), 'file:///home/u/x%231.png');
  assert.strictEqual(assetUrl('https://h/i.png', 'C:\\docs\\a.md'), 'https://h/i.png');
  assert.strictEqual(assetUrl('data:image/png;base64,AAA', 'C:\\docs\\a.md'), 'data:image/png;base64,AAA');
  assert.strictEqual(assetUrl('', 'C:\\docs\\a.md'), '');
});

test('roster order: new docs on top, reopen keeps place, close picks the neighbour', () => {
  assert.deepStrictEqual(withDoc(['a', 'b'], 'c'), ['c', 'a', 'b']);
  assert.deepStrictEqual(withDoc(['a', 'b'], 'b'), ['a', 'b']);
  assert.deepStrictEqual(withoutDoc(['a', 'b', 'c'], 'b'), ['a', 'c']);
  assert.strictEqual(nextAfterClose(['a', 'b', 'c'], 'b'), 'c');
  assert.strictEqual(nextAfterClose(['a', 'b', 'c'], 'c'), 'b');
  assert.strictEqual(nextAfterClose(['a'], 'a'), null);
  assert.strictEqual(nextAfterClose(['a'], 'zz'), null);
});

test('toggleTask: flips the n-th task marker, skipping fenced code, keeping everything else byte-for-byte', () => {
  const src = '# T\n\n- [ ] one\n- [x] two\n```\n- [ ] not a task\n```\n  * [ ] nested\n> 1. [X] quoted\n- plain\n';
  assert.strictEqual(toggleTask(src, 0, true), src.replace('- [ ] one', '- [x] one'));
  assert.strictEqual(toggleTask(src, 1, false), src.replace('- [x] two', '- [ ] two'));
  assert.strictEqual(toggleTask(src, 2, true), src.replace('* [ ] nested', '* [x] nested'));
  assert.strictEqual(toggleTask(src, 3, false), src.replace('1. [X] quoted', '1. [ ] quoted'));
  assert.strictEqual(toggleTask(src, 4, true), null);
  assert.strictEqual(toggleTask('- [ ]x not a task\n', 0, true), null);
  assert.strictEqual(toggleTask('- [ ]\r\n', 0, true), '- [x]\r\n'); // CRLF files keep their endings
});
