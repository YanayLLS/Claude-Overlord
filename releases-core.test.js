// Run: node releases-core.test.js
const assert = require('assert');
const { parseSource, validateConfig, requestsFor, buildGrid, age, commitTitle, DEFAULT_SOURCE } = require('./releases-core');

// ── parseSource ───────────────────────────────────────
assert.deepStrictEqual(parseSource('LLSLtd/frontlineio-frontend:.overlord/releases.json@dev'),
  { kind: 'gh', repo: 'LLSLtd/frontlineio-frontend', path: '.overlord/releases.json', ref: 'dev' });
assert.deepStrictEqual(parseSource('o/r:cfg/releases.json'), { kind: 'gh', repo: 'o/r', path: 'cfg/releases.json', ref: '' });
assert.deepStrictEqual(parseSource('C:\\team\\releases.json'), { kind: 'file', path: 'C:\\team\\releases.json' });
assert.deepStrictEqual(parseSource('/home/me/releases.json'), { kind: 'file', path: '/home/me/releases.json' });
assert.strictEqual(parseSource(''), null);
assert.strictEqual(parseSource('o/r:../../etc@dev'), null);       // path traversal
assert.strictEqual(parseSource('o/r:a.json@dev&calc'), null);     // shell metachar in ref
assert.strictEqual(parseSource('relative/releases.json'), null);  // neither absolute nor owner/repo:path
assert.ok(parseSource(DEFAULT_SOURCE));

// ── validateConfig ────────────────────────────────────
const good = {
  envs: ['dev', 'alpha', 'prod'],
  repos: [
    { repo: 'o/web', branches: { dev: 'dev', alpha: 'alpha', prod: 'master' }, promote: ['dev', 'alpha', 'prod'] },
    { repo: 'o/id', label: 'Identity', branches: { dev: 'dev', prod: 'main' }, promote: ['dev', 'prod'] },
    { repo: 'o/infra', note: 'applied by hand' },
  ],
};
assert.deepStrictEqual(validateConfig(good), []);
assert.deepStrictEqual(validateConfig(null), ['config must be a JSON object']);
assert.deepStrictEqual(validateConfig({ envs: [], repos: [] }), ['envs: must be a non-empty array of names']);
assert.deepStrictEqual(validateConfig({ envs: ['dev', 'dev'], repos: [] }), ['envs[1]: "dev" is listed twice']);
{
  const bad = validateConfig({
    envs: ['dev', 'prod'],
    repos: [
      { repo: 'not a repo', branches: { dev: 'dev' } },
      { repo: 'o/a', branches: { qa: 'qa', dev: 'dev&calc' } },
      { repo: 'o/b', branches: { dev: 'dev' }, promote: ['dev', 'prod'] },
      { repo: 'o/c' },
      { repo: 'o/d', note: 'x', branches: { dev: 'dev' } },
      { repo: 'o/e', branches: { dev: 'dev', prod: 'main' }, promote: ['dev'] },
    ],
  });
  // every problem reported at once, each with its path
  assert.deepStrictEqual(bad, [
    'repos[0].repo: "not a repo" is not owner/name',
    'repos[1].branches.qa: "qa" is not in envs',
    'repos[1].branches.dev: "dev&calc" is not a valid branch name',
    'repos[2].promote[1]: "prod" is not in branches',
    'repos[3]: needs branches or note',
    'repos[4]: has both branches and note — pick one',
    'repos[5].promote: needs at least 2 envs',
  ]);
}

// The Frontline default from the spec must validate as-is.
const frontline = {
  envs: ['dev', 'alpha', 'staging', 'prod'],
  repos: [
    { repo: 'LLSLtd/frontlineio-frontend', branches: { dev: 'dev', alpha: 'alpha', staging: 'staging', prod: 'master' }, promote: ['dev', 'alpha', 'prod'] },
    { repo: 'LLSLtd/frontline.io-web', branches: { dev: 'dev', alpha: 'alpha', staging: 'staging', prod: 'prod-one' }, promote: ['dev', 'alpha', 'prod'] },
    { repo: 'LLSLtd/identity-server', branches: { dev: 'dev', prod: 'main' }, promote: ['dev', 'prod'] },
    { repo: 'LLSLtd/back-office', branches: { dev: 'dev', prod: 'master' }, promote: ['dev', 'prod'] },
    { repo: 'LLSLtd/AI-chat-front', branches: { staging: 'staging', prod: 'prod-one' }, promote: ['staging', 'prod'] },
    { repo: 'LLSLtd/remote-support-web', branches: { staging: 'staging', prod: 'prod-one' }, promote: ['staging', 'prod'] },
    { repo: 'LLSLtd/Websocket', branches: { prod: 'master' } },
    { repo: 'LLSLtd/dbschemas', note: 'Publishes to npm on every push to dev — not an environment' },
    { repo: 'LLSLtd/servers-infrastructure', note: 'Applied by hand — dev branch = prod tfvars' },
  ],
};
assert.deepStrictEqual(validateConfig(frontline), []);

// ── requestsFor ───────────────────────────────────────
{
  const r = requestsFor(good);
  assert.deepStrictEqual(r.commits.map(c => `${c.repo}|${c.env}|${c.branch}`),
    ['o/web|dev|dev', 'o/web|alpha|alpha', 'o/web|prod|master', 'o/id|dev|dev', 'o/id|prod|main']);
  // compare base = where it goes, head = where it is now
  assert.deepStrictEqual(r.compares, [
    { repo: 'o/web', from: 'dev', to: 'alpha', base: 'alpha', head: 'dev' },
    { repo: 'o/web', from: 'alpha', to: 'prod', base: 'master', head: 'alpha' },
    { repo: 'o/id', from: 'dev', to: 'prod', base: 'main', head: 'dev' },
  ]);
}

// ── buildGrid ─────────────────────────────────────────
{
  const c = (sha) => ({ sha, title: 't ' + sha, author: 'ann', date: '2026-09-25T10:00:00Z', url: 'u/' + sha });
  const g = buildGrid(good, {
    commits: {
      'o/web|dev': c('aaaaaaa1'), 'o/web|alpha': { missing: true }, 'o/web|prod': { error: 'boom' },
      'o/id|dev': c('ccccccc1'), 'o/id|prod': c('ddddddd1'),
    },
    compares: {
      'o/web|dev': { to: 'alpha', ahead: 12, url: 'cmp1', commits: [] },
      'o/web|alpha': { error: 'nope' },
      'o/id|dev': { to: 'prod', ahead: 4, url: 'cmp3', commits: [] },
    },
  });
  assert.deepStrictEqual(g.envs, ['dev', 'alpha', 'prod']);
  const [web, id, infra] = g.rows;
  assert.strictEqual(web.label, 'web');                     // default label = repo name part
  assert.strictEqual(web.cells[0].commit.sha, 'aaaaaaa1');
  assert.deepStrictEqual(web.cells[0].next, { to: 'alpha', ahead: 12, url: 'cmp1', commits: [] });
  assert.strictEqual(web.cells[1].missing, true);           // 404 marks only its own cell
  assert.strictEqual(web.cells[1].next.error, 'nope');
  assert.strictEqual(web.cells[2].error, 'boom');
  assert.strictEqual(web.cells[2].next, null);              // last step has no outgoing arrow
  assert.strictEqual(id.label, 'Identity');
  assert.strictEqual(id.cells[1], null);                    // no alpha branch → empty cell
  assert.strictEqual(id.cells[0].next.to, 'prod');          // non-adjacent step still lands on dev's cell
  assert.strictEqual(infra.note, 'applied by hand');
  assert.strictEqual(infra.cells, undefined);
  // a cell whose request hasn't come back yet is loading, not an error
  const empty = buildGrid(good, { commits: {}, compares: {} });
  assert.strictEqual(empty.rows[0].cells[0].loading, true);
}

// ── commitTitle ───────────────────────────────────────
// A merge commit's headline is noise; the PR title is its body's first line.
assert.strictEqual(commitTitle('Merge pull request #933 from LLSLtd/fix/x', 'fix: iOS pull to refresh\n\nmore'),'#933 fix: iOS pull to refresh');
assert.strictEqual(commitTitle('Merge pull request #933 from LLSLtd/fix/x', ''), 'Merge pull request #933 from LLSLtd/fix/x');
assert.strictEqual(commitTitle('feat: squash-merged (#12)', 'body'), 'feat: squash-merged (#12)');

// ── age ───────────────────────────────────────────────
const now = Date.parse('2026-09-25T12:00:00Z');
assert.strictEqual(age('2026-09-25T11:59:40Z', now), 'now');
assert.strictEqual(age('2026-09-25T11:20:00Z', now), '40m');
assert.strictEqual(age('2026-09-25T10:00:00Z', now), '2h');
assert.strictEqual(age('2026-09-22T12:00:00Z', now), '3d');
assert.strictEqual(age('2026-08-21T12:00:00Z', now), '5w');
assert.strictEqual(age('garbage', now), '');


// ── deploy: per-env workflow file or "manual" ─────────
{
  const cfg = { envs: ['dev', 'prod'], repos: [{ repo: 'o/r', branches: { dev: 'dev', prod: 'main' }, deploy: { dev: 'deploy.yml', prod: 'manual' } }] };
  assert.deepStrictEqual(validateConfig(cfg), []);
  const g = buildGrid(cfg, {});
  assert.strictEqual(g.rows[0].cells[0].deploy, 'deploy.yml');
  assert.strictEqual(g.rows[0].cells[1].deploy, 'manual');
  const bare = buildGrid({ envs: ['dev'], repos: [{ repo: 'o/r', branches: { dev: 'dev' } }] }, {});
  assert.strictEqual(bare.rows[0].cells[0].deploy, null);
  assert.deepStrictEqual(validateConfig({ envs: ['dev'], repos: [{ repo: 'o/r', branches: { dev: 'dev' }, deploy: { prod: 'x.yml' } }] }),
    ['repos[0].deploy.prod: "prod" is not in branches']);
  assert.deepStrictEqual(validateConfig({ envs: ['dev'], repos: [{ repo: 'o/r', branches: { dev: 'dev' }, deploy: { dev: 'a b&c' } }] }),
    ['repos[0].deploy.dev: "a b&c" is not a workflow file or "manual"']);
}

// ── deploy run: last run of that env's workflow rides on the cell ──
{
  const cfg = { envs: ['dev'], repos: [{ repo: 'o/r', branches: { dev: 'dev' }, deploy: { dev: 'd.yml' } }] };
  const run = { state: 'failure', url: 'u', date: '2026-01-01T00:00:00Z' };
  assert.deepStrictEqual(buildGrid(cfg, { deploys: { 'o/r|dev': run } }).rows[0].cells[0].run, run);
  assert.strictEqual(buildGrid(cfg, {}).rows[0].cells[0].run, null);
  assert.deepStrictEqual(requestsFor(cfg).deploys, [{ repo: 'o/r', env: 'dev', branch: 'dev', file: 'd.yml' }]);
}

// ── group: optional section name carried onto the row ──
{
  const g = buildGrid({ envs: ['dev'], repos: [{ repo: 'o/a', group: 'App', branches: { dev: 'dev' } }, { repo: 'o/b', note: 'x' }] }, {});
  assert.strictEqual(g.rows[0].group, 'App');
  assert.strictEqual(g.rows[1].group, '');
  assert.deepStrictEqual(validateConfig({ envs: ['dev'], repos: [{ repo: 'o/a', group: 5, branches: { dev: 'dev' } }] }), ['repos[0].group: must be a string']);
}

// ── failedDeploys: which cells the footer badge warns about ──
{
  const { failedDeploys } = require('./releases-core');
  const cfg = { envs: ['dev', 'prod'], repos: [
    { repo: 'o/a', label: 'front', branches: { dev: 'dev', prod: 'main' }, deploy: { dev: 'd.yml', prod: 'p.yml' } },
    { repo: 'o/b', branches: { dev: 'dev' }, deploy: { dev: 'manual' } },
  ] };
  const g = buildGrid(cfg, { deploys: { 'o/a|dev': { state: 'failure' }, 'o/a|prod': { state: 'success' } } });
  assert.deepStrictEqual(failedDeploys(g), ['front · dev']);
  assert.deepStrictEqual(failedDeploys(null), []);
}

// ── runState: a red run is only a failed DEPLOY if a deploy job/step is what failed ──
{
  const { runState } = require('./releases-core');
  assert.strictEqual(runState('success', []), 'success');
  assert.strictEqual(runState('failure', [{ job: 'deploy', step: 'Deploy to Azure Web App' }]), 'failure');
  assert.strictEqual(runState('failure', [{ job: 'technical-pr-to-dev', step: 'Open (or reuse) the staging → dev technical PR' }]), 'partial');
  assert.strictEqual(runState('failure', []), 'failure'); // no job detail: assume the worst
  assert.strictEqual(runState('cancelled', []), 'cancelled');
}

// ── a deploy workflow that has never once succeeded isn't how that env gets deployed ──
{
  const { runState } = require('./releases-core');
  assert.strictEqual(runState('failure', [{ job: 'deploy', step: 'Deploy to Azure Web App' }], false), 'dead');
  assert.strictEqual(runState('failure', [{ job: 'deploy', step: 'Deploy' }], true), 'failure');
  assert.strictEqual(runState('failure', [{ job: 'x', step: 'open PR' }], false), 'partial'); // side job red on every run, deploy fine
  assert.strictEqual(runState('success', [], false), 'success'); // the run itself succeeded
  const { failedDeploys } = require('./releases-core');
  const g = buildGrid({ envs: ['dev'], repos: [{ repo: 'o/a', branches: { dev: 'dev' }, deploy: { dev: 'd.yml' } }] }, { deploys: { 'o/a|dev': { state: 'dead' } } });
  assert.deepStrictEqual(failedDeploys(g), []); // not "failing": it never worked, so nothing broke
}

// ── live: the commit an env really runs, read from a file that pins it (e.g. terraform tfvars) ──
{
  const { liveSha } = require('./releases-core');
  const tf = '  "ai-microservice" = {\n    tag                  = "1.0.15-dfba9c5"\n  }\n  "x" = {\n    tag = "latest"\n  }';
  const m = String.raw`"ai-microservice" = \{\s*tag\s*=\s*"[^"]*?([0-9a-f]{7,40})"`;
  assert.strictEqual(liveSha(tf, m), 'dfba9c5');
  assert.strictEqual(liveSha('nothing here', m), null);
  assert.strictEqual(liveSha(tf, '(unclosed'), null); // a bad pattern is "unknown", not a crash

  const cfg = { envs: ['dev', 'prod'], repos: [{ repo: 'o/ai', branches: { dev: 'dev', prod: 'dev' }, deploy: { prod: 'manual' },
    live: { prod: { from: 'o/infra:env/prod.tfvars@dev', match: m } } }] };
  assert.deepStrictEqual(validateConfig(cfg), []);
  assert.deepStrictEqual(requestsFor(cfg).lives, [{ repo: 'o/ai', env: 'prod', branch: 'dev', from: 'o/infra:env/prod.tfvars@dev', match: m }]);
  const live = { sha: 'dfba9c5aaaa', behind: 3 };
  assert.deepStrictEqual(buildGrid(cfg, { lives: { 'o/ai|prod': live } }).rows[0].cells[1].live, live);
  assert.strictEqual(buildGrid(cfg, {}).rows[0].cells[0].live, null);

  const bad = (live) => validateConfig({ envs: ['dev'], repos: [{ repo: 'o/a', branches: { dev: 'dev' }, live }] });
  assert.deepStrictEqual(bad({ prod: { from: 'o/i:f@dev', match: '(x)' } }), ['repos[0].live.prod: "prod" is not in branches']);
  assert.deepStrictEqual(bad({ dev: { from: 'nope', match: '(x)' } }), ['repos[0].live.dev.from: must be owner/repo:path[@ref]']);
  assert.deepStrictEqual(bad({ dev: { from: 'o/i:f@dev', match: 'no group' } }), ['repos[0].live.dev.match: must be a regex with one (capture group) for the sha']);
}

// ── buildTimeline: every env branch's recent commits, newest first; env filter; live-pinned envs skipped ──
{
  const { buildTimeline } = require('./releases-core');
  const cfg = { envs: ['dev', 'prod'], repos: [
    { repo: 'o/a', label: 'front', branches: { dev: 'dev', prod: 'main' } },
    { repo: 'o/ai', branches: { dev: 'dev', prod: 'dev' }, live: { prod: { from: 'o/i:f@dev', match: '(x)' } } },
  ] };
  const c = (sha, date) => ({ sha, title: 't' + sha, date, url: 'u' + sha });
  const history = {
    'o/a|dev': [c('d2', '2026-09-24T10:00:00Z'), c('d1', '2026-09-20T10:00:00Z')],
    'o/a|prod': [c('p1', '2026-09-22T10:00:00Z')],
    'o/ai|dev': [c('a1', '2026-09-23T10:00:00Z')],
    'o/ai|prod': [c('a1', '2026-09-23T10:00:00Z')],
  };
  const all = buildTimeline(cfg, history);
  assert.deepStrictEqual(all.map(e => e.label + ':' + e.env + ':' + e.sha), ['front:dev:d2', 'ai:dev:a1', 'front:prod:p1', 'front:dev:d1']);
  assert.deepStrictEqual(buildTimeline(cfg, history, 'prod').map(e => e.sha), ['p1']);
  assert.deepStrictEqual(buildTimeline(cfg, {}), []);
}
// ── firstParentChain: merges on the branch, not what they brought along ──
{
  const { firstParentChain } = require('./releases-core');
  const n = (oid, parent) => ({ oid, parents: { nodes: parent ? [{ oid: parent }] : [] } });
  // m2 merged feature f1 (whose parent is m1); history order interleaves them
  const nodes = [n('m2', 'm1'), n('f1', 'm1'), n('m1', 'm0'), n('m0')];
  assert.deepStrictEqual(firstParentChain(nodes, 10).map(x => x.oid), ['m2', 'm1', 'm0']);
  assert.deepStrictEqual(firstParentChain(nodes, 2).map(x => x.oid), ['m2', 'm1']);
  assert.deepStrictEqual(firstParentChain([], 5), []);
}
console.log('releases-core: all passed');
