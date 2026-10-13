// Run: node release-run.test.js
const assert = require('assert');
const { isHotfix, hotfixTitles, releaseBody, checksState, rowStatus, runRelease } = require('./release-run');

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
assert.strictEqual(checksState([], { state: 'failure', total_count: 1, statuses: [{ context: 'snyk', state: 'failure' }] }), 'fail');
// a commit status (not a check run) that's also red on the target isn't a blocker either
assert.strictEqual(checksState([], { statuses: [{ context: 'security/snyk (LLS)', state: 'failure' }] }, ['security/snyk (LLS)']), 'none');
// a check that also fails on the target branch was red before the release: not a blocker
assert.strictEqual(checksState([{ name: 'snyk', status: 'completed', conclusion: 'failure' }, { name: 'ci', status: 'completed', conclusion: 'success' }], null, ['snyk']), 'pass');

// ── rowStatus ──
assert.strictEqual(rowStatus({ nothing: true }), 'nothing');
assert.strictEqual(rowStatus({ pr: {}, checks: 'fail' }), 'blocked');
assert.strictEqual(rowStatus({ pr: {}, backMerge: { conflict: true } }), 'blocked');
assert.strictEqual(rowStatus({ pr: {}, checks: 'pending' }), 'ok');
assert.strictEqual(rowStatus({ error: 'x' }), 'error');
assert.strictEqual(rowStatus({ pr: {}, conflict: null, checks: 'pending' }), 'ok'); // unknown mergeability isn't a blocker…
assert.strictEqual(rowStatus({ pr: {}, merged: true }), 'merged');

// ── runRelease against a fake gh: open the release PR + a back-merge, nothing-to-ship row, reuse ──
(async () => {
  const calls = [];
  const gh = async (args) => {
    const a = args.join(' '); calls.push(a);
    if (a.includes('compare/master...dev')) return { data: { ahead_by: 2, files: [{}], commits: [c('fix(x): one'), c('Merge pull request #9', 2)] } };
    if (a.includes('compare/dev...master')) return { data: { commits: [c('fix: hotfix on master')] } };
    if (a.includes('compare/main...dev')) return { data: { ahead_by: 0, files: [], commits: [] } };
    // an unrelated open PR into master (other head branch) must not be mistaken for the release PR
    if (a.includes('-f state=open') && a.includes('base=master')) return { data: [{ number: 3, head: { ref: 'hotfix/x', repo: { full_name: 'o/f' } } }] };
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
  assert.ok(front.body && front.body.includes('Promotes'), 'opened PRs carry their body for later patches');

  // re-check after a fix: the back-merge is merged (no hotfixes left) and checks are green → no longer blocked, nothing opened
  const { recheckRelease } = require('./release-run');
  const posted = [];
  const fixed = await recheckRelease(async (args) => {
    const a = args.join(' ');
    if (a.includes('-X POST')) { posted.push(a); return { error: 'must not open anything' }; }
    if (a.includes('compare/master...dev')) return { data: { ahead_by: 2, files: [{}], commits: [c('fix(x): one')] } };
    if (a.includes('compare/dev...master')) return { data: { commits: [c('Merge pull request #11', 2)] } };
    if (a.includes('-f state=open') && a.includes('base=master')) return { data: [{ number: 10, html_url: 'u10', head: { ref: 'dev', repo: { full_name: 'o/f' } } }] };
    if (/repos\/o\/f\/pulls\/10$/.test(a)) return { data: { mergeable: true, head: { sha: 'new' } } };
    if (a.includes('check-runs')) return { data: { check_runs: [{ name: 'ci', status: 'completed', conclusion: 'success' }] } };
    if (a.includes('/status')) return { data: { state: 'success', total_count: 0 } };
    return { data: null };
  }, [{ ...front }], { writeJson: () => 'f.json', wait: async () => {} });
  assert.deepStrictEqual([fixed[0].status, fixed[0].backMerge, fixed[0].checks, posted.length], ['ok', null, 'pass', 0]);

  // prHealth: GitHub never decides mergeability → conflict is null (unknown), not false
  const { prHealth } = require('./release-run');
  const h = await prHealth(async (args) => {
    const a = args.join(' ');
    if (/pulls\/5$/.test(a)) return { data: { state: 'open', mergeable: null } };
    return { data: {} };
  }, 'o/r', 5, 'main', async () => {});
  assert.strictEqual(h.conflict, null);
  const closed = await prHealth(async () => ({ data: { state: 'closed', merged: true } }), 'o/r', 5, 'main', async () => {});
  assert.deepStrictEqual(closed, { closed: true, merged: true });
  // required checks: with branch protection, only a failing REQUIRED check blocks
  const { requiredChecks } = require('./release-run');
  assert.deepStrictEqual(requiredChecks({ protection: { required_status_checks: { contexts: ['Production Build'], checks: [{ context: 'Production Build' }] } } }), ['Production Build']);
  assert.deepStrictEqual(requiredChecks({ protected: false }), []);
  const prot = await prHealth(async (args) => {
    const a = args.join(' ');
    if (/pulls\/7$/.test(a)) return { data: { state: 'open', mergeable: true, head: { sha: 'h' } } };
    if (a.includes('commits/h/check-runs')) return { data: { check_runs: [
      { name: 'Production Build', status: 'completed', conclusion: 'success' }, { name: 'Deploy to dev', status: 'completed', conclusion: 'failure' }] } };
    if (a.includes('commits/h/status')) return { data: { statuses: [{ context: 'security/snyk', state: 'failure' }] } };
    if (a.includes('branches/master')) return { data: { protection: { required_status_checks: { contexts: ['Production Build'] } } } };
    return { data: {} };
  }, 'o/f', 7, 'master', async () => {});
  assert.strictEqual(prot.checks, 'pass');
  assert.deepStrictEqual(prot.advisory.sort(), ['Deploy to dev', 'security/snyk']);
  // ── dbschemas: shipped version, new fields, fields the release uses ──
  const { addedSchemaFields, fieldsUsed, shippedVersion, dbschemasCheck, buildCoverage } = require('./release-run');
  assert.deepStrictEqual(addedSchemaFields([
    { filename: 'Procedure.js', patch: '@@\n+    coverImgIsCustom: Boolean,\n     title: String,\n+    DeletedBy: UserRefType,' },
    { filename: 'Room.test.js', patch: '+    testOnly: 1,' }, { filename: 'package.json', patch: '+  "version": "1",' },
  ]), ['coverImgIsCustom', 'DeletedBy']);
  assert.deepStrictEqual(fieldsUsed(['coverImgIsCustom', 'DeletedBy'], [{ filename: 'a.js', patch: '+ if (p.coverImgIsCustom) x()\n- DeletedBy old' }]), ['coverImgIsCustom']);
  // a bare word isn't a use; a key or a quoted name is; schema keywords never count as fields
  assert.deepStrictEqual(fieldsUsed(['Draft', 'Label', 'Note'], [{ filename: 'a.ts', patch: "+ // Draft mode\n+ { Label: x }\n+ get('Note')" }]), ['Label', 'Note']);
  assert.deepStrictEqual(addedSchemaFields([{ filename: 'A.js', patch: '+    type: String,\n+    required: true,\n+    IsSoloAllowed: Boolean,' }]), ['IsSoloAllowed']);
  // keys whose value is code are not fields; a field the shipped package already declares is not new
  assert.deepStrictEqual(addedSchemaFields([{ filename: 'writer.js', patch: '+    updateOne: {\n+        filter: keyOf(ref),\n+        update: {$set: x},\n+        upsert: true,\n+    connection: this.model.db,\n+    isEnabled: () => true,' }]), []);
  assert.deepStrictEqual(addedSchemaFields([{ filename: 'PartLens.js', patch: '+    Name: String,\n+    Tags: [String],\n+    At: {type: Date},\n+    Kind: Number, // the kind' }], new Set(['Name'])), ['Tags', 'Kind']);
  assert.deepStrictEqual(addedSchemaFields([{ filename: 'Procedure.js', patch: '+    ProcedureType: {\n+        type: Number,\n+    },\n+    updateOne: {\n+        filter: x,' }]), ['ProcedureType']);
  // only source files count as a use: a workflow's `--query '{State:State}'` is not
  assert.deepStrictEqual(fieldsUsed(['State'], [{ filename: '.github/workflows/deploy.yml', patch: "+ --query '{State:State}'" }]), []);
  const lock = { packages: { 'node_modules/@llsltd/dbschemas': { version: '26.3.77' } } };
  const pkgJ = { dependencies: { '@llsltd/dbschemas': '^26.3.77' } };
  assert.deepStrictEqual(shippedVersion({ pkg: pkgJ, lock, dockerfile: 'RUN npm ci', latest: '26.3.95' }), { version: '26.3.77', via: 'lock' });
  assert.deepStrictEqual(shippedVersion({ pkg: pkgJ, lock, dockerfile: 'RUN npm install @llsltd/dbschemas@latest', latest: '26.3.95' }), { version: '26.3.95', via: 'latest' });
  assert.strictEqual(shippedVersion({ pkg: { dependencies: {} }, lock, dockerfile: '', latest: '1' }), null);
  const dbs = await dbschemasCheck(async (args) => {
    const a = args.join(' ');
    if (a.includes('package.json')) return { data: pkgJ };
    if (a.includes('package-lock.json')) return { data: lock };
    if (a.includes('Dockerfile')) return { data: { content: Buffer.from('RUN npm ci').toString('base64') } };
    if (a.includes('dbschemas/git/trees/26.3.77')) return { data: { tree: [{ type: 'blob', path: 'Procedure.js' }, { type: 'blob', path: 'Procedure.test.js' }] } };
    if (a.includes('dbschemas/contents/Procedure.js?ref=26.3.77')) return { data: { content: Buffer.from('    title: String,\n').toString('base64') } };
    if (a.includes('dbschemas/compare/26.3.77...26.3.95')) return { data: {
      commits: [{ commit: { message: 'feat(procedure): cover' } }, { commit: { message: 'bump package version to 26.3.95 [skip ci]' } }],
      files: [{ filename: 'Procedure.js', patch: '+    coverImgIsCustom: Boolean,\n+    title: String,' }] } };
    return { error: 'unexpected ' + a };
  }, 'o/id', 'dev', [{ filename: 'src/a.js', patch: '+ doc.coverImgIsCustom = true\n+ doc.title = x' }], '26.3.95');
  assert.deepStrictEqual({ shipped: dbs.shipped, behind: dbs.behind, used: dbs.used }, { shipped: '26.3.77', behind: 1, used: ['coverImgIsCustom'] });
  assert.strictEqual(rowStatus({ pr: {}, checks: 'pass', dbschemas: dbs }), 'blocked');
  assert.strictEqual(buildCoverage([{ name: 'Production Build', status: 'completed', conclusion: 'success' }]), 'pass');
  assert.strictEqual(buildCoverage([{ name: 'Semgrep', status: 'completed', conclusion: 'success' }]), 'none');
  // a fix branch (Hotfix / Advanced): commits it shares with the repo's usual source ride along; merges don't count
  const { carriedCommits, prodDbschemas } = require('./release-run');
  const cm = (sha, msg, parents = 1) => ({ sha, commit: { message: msg }, parents: Array(parents).fill({}) });
  assert.deepStrictEqual(carriedCommits([cm('a', 'fix: author names'), cm('b', 'feat: dev work\nbody'), cm('m', 'Merge dev', 2)], [cm('a', 'fix: author names')]), ['feat: dev work']);
  assert.deepStrictEqual(carriedCommits([cm('a', 'fix')], [cm('a', 'fix')]), []);
  // a hotfix that changes the dbschemas version prod runs: what the other prod repos run
  const dbsAt = (v) => async (args) => {
    const a = args.join(' ');
    if (a.includes('package.json')) return { data: { dependencies: { '@llsltd/dbschemas': '^' + v(a) } } };
    if (a.includes('package-lock.json')) return { data: {} };
    if (a.includes('Dockerfile')) return { data: { content: Buffer.from('RUN npm ci').toString('base64') } };
    return { error: 'unexpected ' + a };
  };
  const bumped = await dbschemasCheck(dbsAt(a => a.includes('ref=master') ? '26.3.70' : '26.3.95'), 'o/b', 'hotfix/x', [], '26.3.95', 'master');
  assert.deepStrictEqual(bumped.bump, { from: '26.3.70', to: '26.3.95' });
  assert.strictEqual((await dbschemasCheck(dbsAt(() => '26.3.95'), 'o/b', 'hotfix/x', [], '26.3.95', 'master')).bump, undefined);
  const prodRepos = await prodDbschemas(async (args) => {
    const a = args.join(' ');
    if (a.includes('repos/o/web/')) return a.includes('package.json') && !a.includes('lock') ? { data: { dependencies: {} } } : { data: {} }; // no dbschemas
    return dbsAt(x => x.includes('o/api') ? '26.3.70' : '26.3.95')(args);
  }, [{ repo: 'o/api', label: 'api', target: 'main' }, { repo: 'o/web', label: 'web', target: 'master' }, { repo: 'o/id', label: 'id', target: 'main' }], '26.3.95');
  assert.deepStrictEqual(prodRepos, [{ label: 'api', version: '26.3.70' }, { label: 'id', version: '26.3.95' }]);
  // a queued Release all starts after a clean or partly released run (a held alpha repo doesn't hold a prod hotfix), not after a stop
  const { startsQueue } = require('./release-run');
  assert.deepStrictEqual(['done', 'partial', 'stopped', 'interrupted'].map(startsQueue), [true, true, false, false]);
  console.log('release-run: all passed');
})().catch(e => { console.error(e); process.exit(1); });
// the board's "↩ N from prod" and the back-merge share one rule: merges and CI deploy markers aren't hotfixes
assert.strictEqual(isHotfix(2, 'Merge pull request #1063 from LLSLtd/dev'), false);
assert.strictEqual(isHotfix(1, 'ci(deploy): staging abc123'), false);
assert.strictEqual(isHotfix(1, 'fix: prod-only hotfix'), true);
