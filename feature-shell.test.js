const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { planShellRedirect } = require('./feature-redirect');

const W = (...p) => path.join('C:\\Users\\me\\.overlord\\worktrees', ...p);
const worktrees = [
  { path: W('Designs', 'F'), repo: 'C:\\Work\\Designs', branch: 'F', feature: 'F' },
  { path: W('frontline.io-web', 'F'), repo: 'C:/Work/frontline.io-web', branch: 'F', feature: 'F' },
];
const repos = ['C:\\Work\\Designs', 'C:/Work/frontline.io-web', 'C:/Work/back-office'];
const plan = (command, cwd = W('Designs', 'F')) => planShellRedirect({ command, cwd, worktrees, repos });

test('changing a main checkout from the shell is caught', () => {
  for (const c of [
    'cd C:/Work/back-office && git commit -am "x"',
    'cd "C:\\Work\\back-office"; git checkout -b feat',
    'git -C C:/Work/back-office push origin HEAD',
    'git -C /c/Work/back-office reset --hard',
    'sed -i "s/a/b/" C:/Work/back-office/src/app.ts',
    'echo hi > C:/Work/back-office/notes.txt',
    'cat x >> "/c/Work/back-office/a b.txt"',
  ]) assert.strictEqual(plan(c) && plan(c).repo, 'C:/Work/back-office', c);
});

test('a repo already in the feature points at its worktree', () => {
  const p = plan('cd C:/Work/frontline.io-web && git stash');
  assert.strictEqual(p.member.path, W('frontline.io-web', 'F'));
});

test('reading, inspecting, copying out and running things in a main checkout pass', () => {
  for (const c of [
    'cat C:/Work/back-office/src/app.ts',
    'git -C C:/Work/back-office log --oneline -5',
    'cd C:/Work/back-office && git status && git diff',
    'cp C:/Work/back-office/src/a.ts ./src/a.ts',
    'grep -rn foo C:/Work/back-office/src > out.txt',
    'C:/Work/Designs/start-full.bat',
    'git commit -m "mention C:/Work/back-office in the message"',
    'sed -i "s/a/b/" src/app.ts',
    'echo hi > C:/Users/me/notes.txt',
    // copying out of a main checkout into the feature's worktree (what the deny message tells agents to do)
    `cd C:/Work/back-office && git diff > p.patch && cd ${W('Designs', 'F')} && git apply p.patch`,
    `cd C:/Work/back-office && git show HEAD:a.ts > ${W('Designs', 'F')}/a.ts && cd ${W('Designs', 'F')} && git add a.ts`,
    `cd C:/Work/back-office && git log -1; cd ${W('Designs', 'F')} && git commit -m x`,
    'git -C C:/Work/back-office stash list',
    'git -C C:/Work/back-office stash show -p',
    'cd C:/Work/back-office && git apply --check p.patch',
  ]) assert.strictEqual(plan(c), null, c);
});

test('a known folder that holds the worktrees (e.g. home) is never treated as a repo to protect', () => {
  const p = planShellRedirect({ command: `echo x > ${W('Designs', 'F')}/a.txt; echo y > C:/Users/me/AppData/Local/Temp/s.txt`, cwd: W('Designs', 'F'), worktrees, repos: [...repos, 'C:\\Users\\me'] });
  assert.strictEqual(p, null);
});

test('agents outside a feature and work inside the feature\'s worktrees are never touched', () => {
  assert.strictEqual(plan('cd C:/Work/back-office && git commit -am x', 'C:/Work/overlord'), null);
  assert.strictEqual(plan(`cd ${W('frontline.io-web', 'F')} && git commit -am x`), null);
});
