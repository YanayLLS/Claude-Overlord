// createWorktree on a path that already exists: adopt a live worktree, clear a dead leftover.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const wt = require('./worktree');

function tmpRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-adopt-'));
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(repo);
  const g = (...a) => execFileSync('git', ['-C', repo, ...a], { stdio: 'pipe' });
  g('init', '-q', '-b', 'dev'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a'); g('add', '.'); g('commit', '-qm', 'init');
  return { root: path.join(dir, 'wts'), repo, g };
}

test('creating a worktree that already exists adopts it and keeps its files', async () => {
  const { root, repo } = tmpRepo();
  const first = await wt.createWorktree({ repo, branch: 'feat-x', base: 'dev', root });
  fs.writeFileSync(path.join(first.dest, 'work.txt'), 'unsaved');
  const again = await wt.createWorktree({ repo, branch: 'feat-x', base: 'dev', root });
  assert.strictEqual(again.adopted, true);
  assert.strictEqual(again.dest, first.dest);
  assert.strictEqual(again.branch, 'feat-x');
  assert.ok(fs.existsSync(path.join(again.dest, 'work.txt')));
});

test('a leftover folder git no longer knows is cleared and the worktree is made fresh', async () => {
  const { root, repo } = tmpRepo();
  const dest = wt.worktreePath(repo, 'feat-y', root);
  fs.mkdirSync(path.join(dest, 'node_modules', 'x'), { recursive: true }); // half-deleted remains
  const r = await wt.createWorktree({ repo, branch: 'feat-y', base: 'dev', root });
  assert.strictEqual(r.adopted, false);
  assert.ok(fs.existsSync(path.join(r.dest, 'a.txt')));
  assert.ok(!fs.existsSync(path.join(r.dest, 'node_modules')));
});

test('removeWorktree deletes the folder and the git registration', async () => {
  const { root, repo, g } = tmpRepo();
  const { dest } = await wt.createWorktree({ repo, branch: 'feat-z', base: 'dev', root });
  fs.mkdirSync(path.join(dest, 'node_modules', 'deep', 'deeper'), { recursive: true });
  await wt.removeWorktree({ repo, dest, branch: 'feat-z', deleteBranch: true });
  assert.ok(!fs.existsSync(dest));
  assert.ok(!String(g('worktree', 'list')).includes('feat-z'));
  assert.ok(!String(g('branch', '--list', 'feat-z')).trim());
});

test('a live worktree of ANOTHER clone with the same folder name is never deleted', async () => {
  const a = tmpRepo(), b = tmpRepo(); // both clones are folders named "repo"
  const root = a.root;
  const made = await wt.createWorktree({ repo: a.repo, branch: 'feat-c', base: 'dev', root });
  fs.writeFileSync(path.join(made.dest, 'work.txt'), 'unsaved');
  await assert.rejects(wt.createWorktree({ repo: b.repo, branch: 'feat-c', base: 'dev', root }), /already/i);
  assert.ok(fs.existsSync(path.join(made.dest, 'work.txt')), 'the other clone\'s files are still there');
});
