// Run: node actions-core.test.js
const assert = require('assert');
const { parseWorkflowInput, runState, actionsRollup, nextPollDelay, diffNewFailures, groupRunsByRepo } = require('./actions-core');

// ── parseWorkflowInput ────────────────────────────────
assert.deepStrictEqual(
  parseWorkflowInput('https://github.com/LLSLtd/frontlineio-frontend/actions/workflows/deploy-ecs.yml'),
  { repo: 'LLSLtd/frontlineio-frontend', file: 'deploy-ecs.yml' });
assert.deepStrictEqual(
  parseWorkflowInput('  https://github.com/o/r/actions/workflows/ci.yaml?query=branch%3Amain  '),
  { repo: 'o/r', file: 'ci.yaml' });
assert.deepStrictEqual(parseWorkflowInput('LLSLtd/frontlineio-frontend'),
  { repo: 'LLSLtd/frontlineio-frontend', file: '' });
assert.deepStrictEqual(parseWorkflowInput('https://github.com/o/r'), { repo: 'o/r', file: '' });
assert.deepStrictEqual(parseWorkflowInput('https://github.com/o/r/actions'), { repo: 'o/r', file: '' });
assert.strictEqual(parseWorkflowInput('not a repo'), null);
assert.strictEqual(parseWorkflowInput(''), null);
assert.strictEqual(parseWorkflowInput(null), null);
// a non-github host must not be mistaken for owner/repo
assert.strictEqual(parseWorkflowInput('https://gitlab.com/o/r'), null);

// ── runState ──────────────────────────────────────────
assert.strictEqual(runState(null), 'none');
assert.strictEqual(runState({ status: 'in_progress' }), 'running');
assert.strictEqual(runState({ status: 'queued' }), 'running');
assert.strictEqual(runState({ status: 'waiting' }), 'running');
assert.strictEqual(runState({ status: 'completed', conclusion: 'success' }), 'success');
assert.strictEqual(runState({ status: 'completed', conclusion: 'failure' }), 'failure');
assert.strictEqual(runState({ status: 'completed', conclusion: 'timed_out' }), 'failure');
assert.strictEqual(runState({ status: 'completed', conclusion: 'cancelled' }), 'cancelled');
assert.strictEqual(runState({ status: 'completed', conclusion: 'skipped' }), 'cancelled');

// ── actionsRollup ─────────────────────────────────────
assert.strictEqual(actionsRollup([]).cls, 'hidden');
assert.deepStrictEqual(actionsRollup([{ state: 'success' }, { state: 'success' }]),
  { cls: '', text: 'All 2 up to date' });
assert.deepStrictEqual(actionsRollup([{ state: 'success' }]),
  { cls: '', text: 'All 1 up to date' });
assert.deepStrictEqual(actionsRollup([{ state: 'running' }, { state: 'failure' }]),
  { cls: 'running', text: '1 running · 1 failed' });
assert.deepStrictEqual(actionsRollup([{ state: 'failure' }, { state: 'success' }]),
  { cls: 'alert', text: '1 failed · 1 ok' });
// red only for MY failure; someone else's breakage is amber, same text
assert.deepStrictEqual(actionsRollup([{ state: 'failure', mine: true }]),
  { cls: 'alert', text: '1 failed' });
assert.deepStrictEqual(actionsRollup([{ state: 'failure', mine: false }]),
  { cls: 'warn', text: '1 failed' });
// mixed: one of them is mine → still red
assert.deepStrictEqual(actionsRollup([{ state: 'failure', mine: false }, { state: 'failure', mine: true }]),
  { cls: 'alert', text: '2 failed' });
// unknown ownership must fail loud, not silently downgrade
assert.strictEqual(actionsRollup([{ state: 'failure' }]).cls, 'alert');
// running still outranks a failure of either kind
assert.strictEqual(actionsRollup([{ state: 'running' }, { state: 'failure', mine: true }]).cls, 'running');
// a per-row fetch error alone must not read as "up to date"
assert.deepStrictEqual(actionsRollup([{ state: 'success', error: 'boom' }]),
  { cls: 'err', text: 'Actions — 1 check failed' });
// never-run workflows count as neither ok nor failed
assert.deepStrictEqual(actionsRollup([{ state: 'none' }]),
  { cls: '', text: '1 never run' });

// ── nextPollDelay ─────────────────────────────────────
assert.strictEqual(nextPollDelay([{ state: 'running' }], 60), 10000);
assert.strictEqual(nextPollDelay([{ state: 'success' }], 60), 60000);
assert.strictEqual(nextPollDelay([{ state: 'success' }], 5), 30000);  // floor
assert.strictEqual(nextPollDelay([], 0), 60000);                      // default
assert.strictEqual(nextPollDelay([{ state: 'running' }], 300), 10000); // running beats interval

// ── diffNewFailures ───────────────────────────────────
const F = { key: 'o/r/d.yml', state: 'failure' };
// running -> failure is the transition we notify on
assert.deepStrictEqual(diffNewFailures([F], { 'o/r/d.yml': 'running' }), [F]);
assert.deepStrictEqual(diffNewFailures([F], { 'o/r/d.yml': 'success' }), [F]);
// still failing from last poll — already notified, stay quiet
assert.deepStrictEqual(diffNewFailures([F], { 'o/r/d.yml': 'failure' }), []);
// first sighting (no prior state) must not fire — e.g. app start, or newly added
assert.deepStrictEqual(diffNewFailures([F], {}), []);
assert.deepStrictEqual(diffNewFailures([F], null), []);
// non-failures never fire
assert.deepStrictEqual(diffNewFailures([{ key: 'k', state: 'success' }], { k: 'failure' }), []);
assert.deepStrictEqual(diffNewFailures([], { k: 'running' }), []);

// ── groupRunsByRepo ───────────────────────────────────
// Keeps the incoming order: the caller sorts running/failed first, so the repo
// that needs you most leads, and its runs stay in that order inside the group.
const R = (repo, name, state) => ({ repo, name, state });
const runs = [R('o/b', 'deploy', 'running'), R('o/a', 'prod', 'failure'), R('o/b', 'prod', 'success'), R('o/a', 'dev', 'success')];
assert.deepStrictEqual(groupRunsByRepo(runs).map(g => [g.repo, g.runs.map(r => r.name)]),
  [['o/b', ['deploy', 'prod']], ['o/a', ['prod', 'dev']]]);
assert.deepStrictEqual(groupRunsByRepo([]), []);

console.log('ok — all actions-core checks passed');

// ── fixRunPlan ────────────────────────────────────────
const { fixRunPlan } = require('./actions-core');
{
  const run = { repo: 'o/r', branch: 'dev', name: 'CI', runNumber: 42, state: 'failure',
    url: 'https://github.com/o/r/actions/runs/123456789' };
  const infos = [
    { dir: 'C:/x/other', repo: 'o/other', branch: 'dev' },
    { dir: 'C:/x/r-wt', repo: 'o/r', branch: 'feat' },
    { dir: 'C:/x/r', repo: 'O/R', branch: 'master' },
  ];
  const p = fixRunPlan(run, infos, ['C:/x/r-wt']);
  // the prompt rides the claude command line (cmd.exe / sh -c) — nothing a shell reads
  assert.ok(!/["&|<>^%!$`\\;\n]/.test(fixRunPlan({ ...run, name: 'x"&$(rm)`;|<>^%!' }, infos, []).prompt));
  // start from the exact commit CI ran when known, else the branch tip
  assert.strictEqual(p.startPoint, 'origin/dev');
  const sha = 'a'.repeat(40);
  assert.strictEqual(fixRunPlan({ ...run, sha }, infos, []).startPoint, sha);
  assert.strictEqual(fixRunPlan({ ...run, sha: 'x&y' }, infos, []).startPoint, 'origin/dev');
  assert.strictEqual(fixRunPlan({ ...run, sha, event: 'pull_request' }, infos, []).startPoint, 'origin/dev');
  // main checkout wins over a worktree; repo match ignores case
  assert.strictEqual(p.repoDir, 'C:/x/r');
  assert.strictEqual(p.branch, 'fix/ci-42');
  assert.strictEqual(p.base, 'dev');
  assert.ok(p.prompt.includes('gh run view 123456789 --repo o/r --log-failed'));
  assert.ok(p.prompt.includes(run.url));
  // an open PR (or a newer push) may already fix it — the agent checks before touching code
  assert.ok(p.prompt.includes('gh pr list --repo o/r --base dev --state open'));
  assert.ok(/already fix/i.test(p.prompt));
  // only a worktree checkout → still usable
  assert.strictEqual(fixRunPlan(run, infos.slice(0, 2), ['C:/x/r-wt']).repoDir, 'C:/x/r-wt');
  // no checkout of that repo → error, not a guess
  assert.ok(fixRunPlan(run, infos.slice(0, 1), []).error);
  // branch names reach a shell (worktree.js on Windows) — anything odd is refused
  assert.ok(fixRunPlan({ ...run, branch: 'x&calc' }, infos, []).error);
  assert.ok(fixRunPlan({ ...run, branch: '' }, infos, []).error);
  // no run id in the url (never-run / workflow list url) → error
  assert.ok(fixRunPlan({ ...run, url: 'https://github.com/o/r/actions/workflows/ci.yml' }, infos, []).error);
}

// ── fixPrPlan: the Fix button on a red PR ─────────────
const { fixPrPlan } = require('./actions-core');
{
  const pr = { repo: 'o/r', number: 948, headRef: 'yanay-features', baseRef: 'dev', url: 'https://github.com/o/r/pull/948' };
  const infos = [{ dir: 'C:/x/r-wt', repo: 'o/r', branch: 'feat' }, { dir: 'C:/x/r', repo: 'o/r', branch: 'yanay-features' }];
  const p = fixPrPlan(pr, infos, ['C:/x/r-wt']);
  assert.strictEqual(p.repoDir, 'C:/x/r');
  // no new worktree: a normal agent in the checkout already on the PR's branch
  assert.strictEqual(p.branch, undefined);
  assert.ok(!p.prompt.includes('git switch'));
  assert.ok(/never stash/i.test(p.prompt));
  // nothing on the PR's branch: the main checkout, told to switch to it
  const sw = fixPrPlan(pr, [{ dir: 'C:/x/r-wt', repo: 'o/r', branch: 'feat' }, { dir: 'C:/x/r', repo: 'o/r', branch: 'dev' }], ['C:/x/r-wt']);
  assert.strictEqual(sw.repoDir, 'C:/x/r');
  assert.ok(sw.prompt.includes('git switch yanay-features'));
  // pushes land on the PR, and it loops on the checks until green
  assert.ok(p.prompt.includes('git push origin HEAD:yanay-features'));
  // pushes without asking, local commits already on the branch go along; a rejected push pulls and retries
  assert.ok(/without asking/i.test(p.prompt));
  assert.ok(/already committed/i.test(p.prompt));
  assert.ok(/rejected/i.test(p.prompt));
  // never ends while checks are still running
  assert.ok(/never end your turn/i.test(p.prompt));
  // reacts to the first red, not the end of the run: a polling loop, per-job logs (--log-failed refuses mid-run)
  assert.ok(!p.prompt.includes('--watch'));
  assert.ok(/every 60 to 90 seconds/.test(p.prompt) && /any check is fail/.test(p.prompt));
  assert.ok(p.prompt.includes('gh api repos/o/r/actions/jobs/(job id)/logs'));
  assert.ok(/every check that is already red/.test(p.prompt));
  // the pr-green skill only exists in the frontend repo
  assert.ok(!p.prompt.includes('pr-green'));
  assert.ok(fixPrPlan({ ...pr, repo: 'LLSLtd/frontlineio-frontend' }, [{ dir: 'C:/x/f', repo: 'LLSLtd/frontlineio-frontend', branch: 'yanay-features' }], []).prompt.includes('pr-green skill'));
  assert.ok(/never merge/i.test(p.prompt));
  assert.ok(!/["&|<>^%!$`\;\n]/.test(fixPrPlan({ ...pr, url: 'x"&$(rm)`;|<>' }, infos, []).prompt));
  // a release PR's head is an env branch: no direct push, a fix PR into it instead
  const rel = fixPrPlan({ ...pr, headRef: 'dev', baseRef: 'alpha' }, infos, []);
  assert.ok(!rel.prompt.includes('HEAD:dev'));
  assert.ok(rel.prompt.includes('--base dev'));
  assert.ok(rel.prompt.includes('git switch -c fix/pr-948 origin/dev'));
  // a worktree already on the PR's branch wins over the main checkout: the agent opens there, no switch
  const onWt = fixPrPlan(pr, [{ dir: 'C:/x/r', repo: 'o/r', branch: 'dev' }, { dir: 'C:/x/r-wt', repo: 'o/r', branch: 'yanay-features' }], ['C:/x/r-wt']);
  assert.strictEqual(onWt.repoDir, 'C:/x/r-wt');
  assert.ok(!onWt.prompt.includes('git switch'));
  assert.ok(onWt.prompt.includes('git push origin HEAD:yanay-features'));
  // refused: a fork (can't push), odd branch names (reach a shell), no checkout
  assert.ok(fixPrPlan({ ...pr, isCrossRepository: true }, infos, []).error);
  assert.ok(fixPrPlan({ ...pr, headRef: 'x&calc' }, infos, []).error);
  assert.ok(fixPrPlan({ ...pr, repo: 'o/none' }, infos, []).error);
}
