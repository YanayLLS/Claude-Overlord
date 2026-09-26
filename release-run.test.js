// Run: node release-run.test.js
const assert = require('assert');
const { hotfixTitles, releaseBody, checksState, rowStatus, runRelease } = require('./release-run');

// ── hotfixTitles: single-parent commits, deploy-bot commits dropped ──
const c = (msg, parents = 1) => ({ commit: { message: msg }, parents: Array(parents).fill({}) });
assert.deepStrictEqual(hotfixTitles([c('fix(x): a\n\nbody'), c('Merge pull request #1', 2), c('ci(deploy): bump')]), ['fix(x): a']);

// ── releaseBody: counts, type, area ──
{
  const b = releaseBody({ env: 'prod', source: 'dev', target: 'master', workflow: 'deploy.yml', ahead: 3,
    titles: ['fix(chat): a', 'feat(chat): b', 'chore: c'], hotfixes: ['fix: hot'] });
  assert.ok(b.includes('`dev` → `master` (**prod**): merging deploys via `deploy.yml`'));
  assert.ok(b.includes('**3 commits** (3 non-merge)'));
  assert.ok(b.includes('⚠ `master` has 1 commit'));
  assert.ok(b.includes('**chat** (2): a; b'));
  assert.ok(/`fix` 1/.test(b) && /`chore` 1/.test(b));
}

// ── checksState ──
assert.strictEqual(checksState([{ status: 'completed', conclusion: 'success' }], { state: 'success', total_count: 0 }), 'pass');
assert.strictEqual(checksState([{ status: 'completed', conclusion: 'failure' }], null), 'fail');
assert.strictEqual(checksState([{ status: 'in_progress', conclusion: null }], null), 'pending');
assert.strictEqual(checksState([], { state: 'pending', total_count: 0 }), 'none');
assert.strictEqual(checksState([], { state: 'failure', total_count: 1 }), 'fail');
// a check that also fails on the target branch was red before the release: not a blocker
assert.strictEqual(checksState([{ name: 'snyk', status: 'completed', conclusion: 'failure' }, { name: 'ci', status: 'completed', conclusion: 'success' }], null, ['snyk']), 'pass');

// ── rowStatus ──
assert.strictEqual(rowStatus({ nothing: true }), 'nothing');
assert.strictEqual(rowStatus({ pr: {}, checks: 'fail' }), 'blocked');
assert.strictEqual(rowStatus({ pr: {}, backMerge: { conflict: true } }), 'blocked');
assert.strictEqual(rowStatus({ pr: {}, checks: 'pending' }), 'ok');
assert.strictEqual(rowStatus({ error: 'x' }), 'error');

// ── runRelease against a fake gh: open the release PR + a back-merge, nothing-to-ship row, reuse ──
(async () => {
  const calls = [];
  const gh = async (args) => {
    const a = args.join(' '); calls.push(a);
    if (a.includes('compare/master...dev')) return { data: { ahead_by: 2, files: [{}], commits: [c('fix(x): one'), c('Merge pull request #9', 2)] } };
    if (a.includes('compare/dev...master')) return { data: { commits: [c('fix: hotfix on master')] } };
    if (a.includes('compare/main...dev')) return { data: { ahead_by: 0, files: [], commits: [] } };
    if (a.includes('-f state=open') && a.includes('base=master')) return { data: [] };
    if (a.includes('-f state=open') && a.includes('base=dev')) return { data: [] };
    if (a.includes('-X POST') && a.includes('pulls')) {
      const n = calls.filter(x => x.includes('-X POST')).length === 1 ? 10 : 11;
      return { data: { number: n, html_url: 'u' + n } };
    }
    if (/repos\/o\/f\/pulls\/1[01]$/.test(a)) return { data: { mergeable: true, head: { sha: 'abc' } } };
    if (a.includes('commits/abc/check-runs')) return { data: { check_runs: [{ name: 'ci', status: 'completed', conclusion: 'failure' }] } };
    if (a.includes('check-runs')) return { data: { check_runs: [] } }; // the target branch is green
    if (a.includes('/status')) return { data: { state: 'success', total_count: 0 } };
    return { error: 'unexpected: ' + a };
  };
  const payloads = [];
  const rows = await runRelease(gh, [
    { repo: 'o/f', env: 'prod', source: 'dev', target: 'master', deploy: 'd.yml' },
    { repo: 'o/id', env: 'prod', source: 'dev', target: 'main' },
  ], { writeJson: (p) => { payloads.push(p); return 'f.json'; }, onRow: () => {}, wait: async () => {} });
  const [front, id] = rows;
  assert.strictEqual(id.status, 'nothing');
  assert.strictEqual(front.pr.number, 10);
  assert.strictEqual(front.backMerge.number, 11);
  assert.strictEqual(front.checks, 'fail');
  assert.strictEqual(front.status, 'blocked');
  assert.deepStrictEqual(payloads.map(p => `${p.head}→${p.base}`), ['dev→master', 'master→dev']);
  assert.ok(payloads[0].body.includes('1 non-merge'));
  assert.ok(payloads[1].body.includes('fix: hotfix on master'));
  console.log('release-run: all passed');
})().catch(e => { console.error(e); process.exit(1); });
