const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const af = require('./agent-feature');
const { git } = require('./worktree');

const R = (p) => path.resolve(p);
const use = (name, input) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name, input }] } });

test('editedFiles reads Edit/Write/MultiEdit/NotebookEdit paths, once each, and skips reads and junk', () => {
  const jsonl = [
    use('Edit', { file_path: 'C:/Work/r/a.js' }), use('Write', { file_path: 'C:\\Work\\r\\new.js' }),
    use('Edit', { file_path: 'c:/work/r/A.js' }), use('NotebookEdit', { notebook_path: 'C:/Work/r/n.ipynb' }),
    use('Read', { file_path: 'C:/Work/r/read-only.js' }), use('Edit', { file_path: 'relative.js' }), 'not json "tool_use"',
  ].join('\n');
  assert.deepStrictEqual(af.editedFiles(jsonl), [R('C:/Work/r/a.js'), R('C:/Work/r/new.js'), R('C:/Work/r/n.ipynb')]);
});

test('parseStatus splits tracked and untracked and skips a rename source', () => {
  const out = ' M src/a.js\0A  b.js\0R  new.js\0old.js\0?? dir/u.txt\0 D gone.js\0';
  assert.deepStrictEqual(af.parseStatus(out), { tracked: ['src/a.js', 'b.js', 'new.js', 'gone.js'], untracked: ['dir/u.txt'] });
});

test('planMove keeps only the agent\'s changed files, flags shared ones, nested repo wins', () => {
  const repos = [
    { root: R('C:/Work/web'), tracked: ['a.js', 'b.js', 'mine-committed-not-dirty.js'].slice(0, 2), untracked: ['new.js', 'theirs.js'] },
    { root: R('C:/Work/web/sub'), tracked: ['x.js'], untracked: [] },
  ];
  const files = [R('C:/Work/web/A.js'), R('C:/Work/web/new.js'), R('C:/Work/web/sub/x.js'), R('C:/Work/web/clean.js')];
  const [web, sub] = af.planMove({ files, repos, others: [R('C:/Work/web/new.js')] });
  assert.deepStrictEqual([web.tracked, web.untracked, web.shared, web.touched], [['a.js'], ['new.js'], ['new.js'], 3]);
  assert.deepStrictEqual([sub.tracked, sub.touched], [['x.js'], 1]);
});

test('newCwd lands at the same spot inside the new worktree', () => {
  const moves = [{ root: R('C:/Work/web'), dest: R('C:/wt/web/F') }];
  assert.strictEqual(af.newCwd(R('C:/Work/web/packages/app'), moves), R('C:/wt/web/F/packages/app'));
  assert.strictEqual(af.newCwd(R('C:/Elsewhere'), moves), null);
});

// ── End to end on real git repos ──────────────────────────────────────────
function tmpRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-af-'));
  const g = (...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8' });
  g('init', '-q', '-b', 'main'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't'); g('config', 'core.autocrlf', 'false');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a1\n'); fs.writeFileSync(path.join(dir, 'b.txt'), 'b1\n'); fs.writeFileSync(path.join(dir, 'c.txt'), 'c1\n');
  fs.writeFileSync(path.join(dir, 'bin.dat'), Buffer.from([0, 1, 2, 3]));
  g('add', '.'); g('commit', '-qm', 'init');
  return { dir, g, rd: (p) => fs.readFileSync(path.join(dir, p), 'utf8') };
}
const makeWt = (wtRoot) => async (m) => { const dest = path.join(wtRoot, path.basename(m.root)); await git(m.root, ['worktree', 'add', '-b', 'feat', dest, m.head]); return dest; };
const dropWt = async (m, dest) => { await git(m.root, ['worktree', 'remove', '--force', dest]); await git(m.root, ['branch', '-D', 'feat']); };

test('convert moves the agent\'s work into a worktree and leaves everyone else\'s in the checkout', async () => {
  const { dir, g, rd } = tmpRepo();
  const wtRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-af-wt-'));
  // The agent committed one change (already on HEAD), then left more uncommitted:
  fs.writeFileSync(path.join(dir, 'c.txt'), 'c2-committed\n'); g('commit', '-qam', 'agent commit');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a2-agent\n');                         // tracked edit
  fs.mkdirSync(path.join(dir, 'src')); fs.writeFileSync(path.join(dir, 'src/new.txt'), 'new\n'); // untracked new file
  fs.writeFileSync(path.join(dir, 'staged.txt'), 'staged\n'); g('add', 'staged.txt');   // staged new file
  fs.writeFileSync(path.join(dir, 'bin.dat'), Buffer.from([9, 9, 0, 9]));               // binary edit
  fs.writeFileSync(path.join(dir, 'b.txt'), 'b2-shared\n');                         // agent AND another agent edited
  fs.writeFileSync(path.join(dir, 'other.txt'), 'someone else\n');                  // only another agent
  const files = ['a.txt', 'src/new.txt', 'staged.txt', 'bin.dat', 'b.txt'].map(p => path.join(dir, p));
  const others = [path.join(dir, 'b.txt'), path.join(dir, 'other.txt')];

  const st = await af.repoState(git, path.join(dir, 'src'));
  assert.strictEqual(st.root.toLowerCase(), R(dir).toLowerCase());
  const moves = af.planMove({ files, repos: [st], others });
  const [m] = await af.convert({ git, moves, makeWorktree: makeWt(wtRoot), dropWorktree: dropWt });
  const wt = (p) => fs.readFileSync(path.join(m.dest, p));

  // The worktree has everything: the commit, the edits, new files, the binary, the shared file.
  assert.strictEqual(String(wt('c.txt')), 'c2-committed\n');
  assert.strictEqual(String(wt('a.txt')), 'a2-agent\n');
  assert.strictEqual(String(wt('src/new.txt')), 'new\n');
  assert.strictEqual(String(wt('staged.txt')), 'staged\n');
  assert.deepStrictEqual([...wt('bin.dat')], [9, 9, 0, 9]);
  assert.strictEqual(String(wt('b.txt')), 'b2-shared\n');
  assert.ok(!fs.existsSync(path.join(m.dest, 'other.txt')), 'another agent\'s file never moves');

  // The checkout lost only the agent's own uncommitted work.
  assert.strictEqual(rd('a.txt'), 'a1\n');
  assert.ok(!fs.existsSync(path.join(dir, 'src/new.txt')));
  assert.ok(!fs.existsSync(path.join(dir, 'staged.txt')));
  assert.deepStrictEqual([...fs.readFileSync(path.join(dir, 'bin.dat'))], [0, 1, 2, 3]);
  assert.strictEqual(rd('b.txt'), 'b2-shared\n', 'shared file stays for the other agent');
  assert.strictEqual(rd('other.txt'), 'someone else\n');
  assert.strictEqual(rd('c.txt'), 'c2-committed\n', 'commits are never taken off the checkout');
});

test('convert changes nothing in any checkout when one repo fails, and drops the worktrees it made', async () => {
  const one = tmpRepo(), two = tmpRepo();
  const wtRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-af-wt-'));
  fs.writeFileSync(path.join(one.dir, 'a.txt'), 'one-edit\n');
  fs.writeFileSync(path.join(two.dir, 'a.txt'), 'two-edit\n');
  const files = [path.join(one.dir, 'a.txt'), path.join(two.dir, 'a.txt')];
  const repos = [await af.repoState(git, one.dir), await af.repoState(git, two.dir)];
  const moves = af.planMove({ files, repos, others: [] });
  let n = 0;
  const flaky = async (m) => { if (++n === 2) throw new Error('boom'); return makeWt(wtRoot)(m); };
  await assert.rejects(af.convert({ git, moves, makeWorktree: flaky, dropWorktree: dropWt }), /boom/);
  assert.strictEqual(one.rd('a.txt'), 'one-edit\n');
  assert.strictEqual(two.rd('a.txt'), 'two-edit\n');
  assert.ok(!fs.existsSync(path.join(wtRoot, path.basename(one.dir))), 'the first worktree was rolled back');
  assert.strictEqual(one.g('branch', '--list', 'feat').trim(), '');
});

test('planForAgent finds its own repo (always) and every repo it edited, skips others and non-repos', async () => {
  const web = tmpRepo(), api = tmpRepo(), idle = tmpRepo(), skipped = tmpRepo();
  const loose = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-af-loose-'));
  fs.mkdirSync(path.join(web.dir, 'pkg'));
  fs.writeFileSync(path.join(api.dir, 'a.txt'), 'api edit\n');
  fs.writeFileSync(path.join(skipped.dir, 'a.txt'), 'other feature\n');
  const files = [path.join(api.dir, 'a.txt'), path.join(api.dir, 'gone/deleted.txt'), path.join(skipped.dir, 'a.txt'), path.join(loose, 'x.txt')];
  const p = await af.planForAgent({ git, cwd: path.join(web.dir, 'pkg'), files, others: [], skipRoot: (r) => R(r).toLowerCase() === R(skipped.dir).toLowerCase() });
  const roots = p.moves.map(m => R(m.root).toLowerCase()).sort();
  assert.deepStrictEqual(roots, [R(web.dir), R(api.dir)].map(x => x.toLowerCase()).sort(), 'web (its folder, no edits) + api; not idle, skipped or loose');
  assert.deepStrictEqual(p.moves.find(m => R(m.root).toLowerCase() === R(api.dir).toLowerCase()).tracked, ['a.txt']);
  assert.ok(idle);
  await assert.rejects(af.planForAgent({ git, cwd: loose, files: [], others: [] }), /not in a git repo/);
});

test('moveSession copies the transcript and its subagents into the new folder\'s project dir', () => {
  const from = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-af-proj-')), to = path.join(os.tmpdir(), 'ov-af-proj-to-' + Date.now());
  const id = '11111111-2222-3333-4444-555555555555';
  fs.writeFileSync(path.join(from, id + '.jsonl'), '{"a":1}\n');
  fs.mkdirSync(path.join(from, id, 'subagents'), { recursive: true });
  fs.writeFileSync(path.join(from, id, 'subagents', 's.jsonl'), '{"b":2}\n');
  const out = af.moveSession({ jsonlFile: path.join(from, id + '.jsonl'), sessionId: id, toDir: to });
  assert.strictEqual(out, path.join(to, id + '.jsonl'));
  assert.strictEqual(fs.readFileSync(out, 'utf8'), '{"a":1}\n');
  assert.strictEqual(fs.readFileSync(path.join(to, id, 'subagents', 's.jsonl'), 'utf8'), '{"b":2}\n');
  assert.ok(fs.existsSync(path.join(from, id + '.jsonl')), 'the original stays as a backup');
});
