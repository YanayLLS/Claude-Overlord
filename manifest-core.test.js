// Run: node manifest-core.test.js
const assert = require('assert');
const M = require('./manifest-core');

// ids: per day, zero-padded, next after the highest that day
assert.strictEqual(M.nextId([], new Date('2026-09-29T10:00:00Z')), '2026-09-29-01');
assert.strictEqual(M.nextId(['2026-09-29-01.json', '2026-09-29-03.json', '2026-09-28-07.json'], new Date('2026-09-29T10:00:00Z')), '2026-09-29-04');
assert.strictEqual(M.manifestPath('2026-09-29-01'), 'releases/2026-09-29-01.json');
assert.strictEqual(M.releaseIdOf('x ' + M.releaseIdMark('2026-09-29-02') + ' y'), '2026-09-29-02');

// a new manifest: prod rows with PRs only, deploy waiting where CI deploys
const rows = [
  { repo: 'o/front', label: 'frontend', source: 'dev', target: 'master', pr: { number: 9, url: 'u9' }, baseSha: 'b1', headSha: 'h1', ahead: 3, deploy: 'd.yml' },
  { repo: 'o/id', label: 'identity', source: 'dev', target: 'main', pr: { number: 4, url: 'u4' }, baseSha: 'b2', headSha: 'h2', deploy: null },
  { repo: 'o/none', label: 'none', source: 'dev', target: 'main' },
];
let m = M.newManifest({ id: '2026-09-29-01', rows, opener: { login: 'alice', clickup: '1' }, manual: [{ repo: 'o/ws', label: 'ws', branch: 'master' }], now: Date.parse('2026-09-29T10:00:00Z') });
assert.strictEqual(m.repos.length, 2);
assert.strictEqual(m.status, 'pending');
assert.deepStrictEqual(m.repos[0].deploy, { workflow: 'd.yml', state: 'waiting', url: null, at: null });

// PR merged → merge sha; all merged → merged; CI deploy result → deployed / deploy-failed
let changed;
[m, changed] = M.applyPr(m, 'o/front', { number: 9, mergeSha: 'm1', mergedAt: 't', signers: ['alice', 'bob'] });
assert.ok(changed && m.status === 'pending');
[m, changed] = M.applyPr(m, 'o/front', { number: 9, mergeSha: 'm1', mergedAt: 't', signers: ['alice', 'bob'] });
assert.strictEqual(changed, false, 'same state again is not a change');
[m] = M.applyPr(m, 'o/id', { number: 4, mergeSha: 'm2' });
assert.strictEqual(m.status, 'merged');
[m] = M.applyDeploy(m, 'o/front', { state: 'success', url: 'r1', at: 't2' });
assert.strictEqual(m.status, 'deployed', 'identity has no CI deploy, so frontend deployed = all deployed');
[m] = M.applyDeploy(m, 'o/front', { state: 'failure', url: 'r2' });
assert.strictEqual(m.status, 'deploy-failed');
[, changed] = M.applyDeploy(m, 'o/front', { state: 'in_progress' });
assert.strictEqual(changed, false, 'an unfinished run changes nothing');

// every PR closed unmerged → abandoned
let a = M.newManifest({ id: 'x', rows: rows.slice(0, 1) });
[a] = M.applyPr(a, 'o/front', { number: 9, closed: true });
assert.strictEqual(a.status, 'abandoned');

// rollback plan: restore each merged repo's merge commit; noop when already there; skips honoured
const plan = M.rollbackPlan(m, { 'o/front': 'm9', 'o/id': 'm2' });
assert.deepStrictEqual(plan.map(p => `${p.repo}:${p.toSha}:${p.noop}`), ['o/front:m1:false', 'o/id:m2:true']);
assert.deepStrictEqual(M.rollbackPlan(m, {}, ['o/front']).map(p => p.repo), ['o/id']);

// past releases: PRs merged close together are one release; the same repo twice splits them
{
  const p = (repo, t, n) => ({ repo, label: repo, source: 'dev', target: 'master', deploy: 'd.yml', number: n, url: 'u' + n, mergedAt: t, mergeSha: 'm' + n, author: 'al' });
  const past = M.groupPast([
    p('o/a', '2026-09-20T10:00:00Z', 1), p('o/b', '2026-09-20T11:00:00Z', 2), // one release
    p('o/a', '2026-09-20T11:30:00Z', 3),                                    // same repo again: a new one
    p('o/a', '2026-09-25T09:00:00Z', 4),
  ]);
  assert.deepStrictEqual(past.map(m => m.id + ':' + m.repos.map(r => r.pr.number).join(',')), ['2026-09-20-01:1,2', '2026-09-20-02:3', '2026-09-25-01:4']);
  assert.ok(past.every(m => m.imported && m.status === 'merged'));
  assert.strictEqual(M.groupPast([p('o/a', '2026-09-20T10:00:00Z', 1), p('o/a', '2026-09-21T10:00:00Z', 2)], { max: 1 }).length, 1);
}
console.log('manifest-core: all passed');
