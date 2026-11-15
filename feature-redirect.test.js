const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { planRedirect } = require('./feature-redirect');

const R = (...p) => path.join('C:\\Work', ...p);
const W = (...p) => path.join('C:\\Users\\me\\.overlord\\worktrees', ...p);
const worktrees = [
  { path: W('Designs', 'Model-update'), repo: R('Designs'), branch: 'Model-update', feature: 'Model update' },
  { path: W('frontline.io-web', 'Model-update'), repo: R('frontline.io-web'), branch: 'Model-update', feature: 'Model update' },
  { path: W('back-office', 'other'), repo: R('back-office'), branch: 'other', feature: 'Other' },
];
const repos = [R('Designs'), R('frontline.io-web'), R('back-office'), R('overlord')];
const cwd = W('Designs', 'Model-update');
const plan = (file, c = cwd) => planRedirect({ file, cwd: c, worktrees, repos });

test('edits inside the agent\'s own worktree or a sibling of the feature pass', () => {
  assert.strictEqual(plan(path.join(cwd, 'src', 'a.ts')), null);
  assert.strictEqual(plan(W('frontline.io-web', 'Model-update', 'x.js')), null);
});

test('a repo outside the feature gets a new member, edit redirected into it', () => {
  const p = plan(R('back-office', 'src', 'app.ts'));
  assert.strictEqual(p.repo, R('back-office'));
  assert.strictEqual(p.member, null); // the Other feature's back-office worktree is not ours
  assert.strictEqual(p.rel, path.join('src', 'app.ts'));
  assert.strictEqual(p.feature, 'Model update');
  assert.strictEqual(p.branch, 'Model-update');
});

test('the main checkout of a repo already in the feature redirects to its worktree', () => {
  const p = plan(R('frontline.io-web', 'server', 'x.js'));
  assert.strictEqual(p.member.path, W('frontline.io-web', 'Model-update'));
  assert.strictEqual(p.rel, path.join('server', 'x.js'));
});

test('paths match case-insensitively, like Windows does', () => {
  assert.strictEqual(plan(R('designs', 'a.ts').toUpperCase()).member.path, W('Designs', 'Model-update'));
});

test('a known folder that holds the feature worktrees (e.g. home) is not a repo to redirect from', () => {
  assert.strictEqual(planRedirect({ file: 'C:\\Users\\me\\AppData\\Local\\Temp\\x.md', cwd, worktrees, repos: [...repos, 'C:\\Users\\me'] }), null);
});

test('files outside every known repo and agents outside a feature are left alone', () => {
  assert.strictEqual(plan('C:\\Users\\me\\notes.md'), null);
  assert.strictEqual(plan(R('overlord', 'main.js'), R('overlord')), null);
  assert.strictEqual(plan(R('overlord-tools', 'x.js')), null); // a sibling folder whose name starts the same
});
