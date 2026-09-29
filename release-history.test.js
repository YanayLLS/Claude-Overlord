// Run: node release-history.test.js — the history module against a fake GitHub (no network).
const assert = require('assert');
const createHistory = require('./release-history');

(async () => {
  const files = new Map(); // path → { sha, content(base64) }
  const prs = { 'o/front#9': { number: 9, state: 'open', merged: false, body: 'b', head: { sha: 'h1' }, user: { login: 'alice' } } };
  const toasts = [], calls = [];
  let n = 0, state = {};
  const fs = require('fs'), os = require('os'), path = require('path');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-'));
  const writeTmp = (p) => { const f = path.join(tmp, `${n++}.json`); fs.writeFileSync(f, JSON.stringify(p)); return f; };
  const input = (args) => JSON.parse(fs.readFileSync(args[args.indexOf('--input') + 1], 'utf8'));
  const gh = async (args) => {
    const a = args.join(' '); calls.push(a);
    let m;
    if ((m = a.match(/^api repos\/LLSLtd\/release-manifests\/contents\/releases\?ref=main$/))) {
      if (!files.size) return { data: { message: 'This repository is empty.', status: '404' } };
      return { data: [...files.entries()].map(([p, f]) => ({ name: p.split('/')[1], path: p, sha: f.sha })) };
    }
    if ((m = a.match(/^api repos\/LLSLtd\/release-manifests\/contents\/(releases\/[\d-]+\.json)\?ref=main$/))) {
      const f = files.get(m[1]); return f ? { data: { sha: f.sha, content: f.content } } : { data: { message: 'Not Found', status: '404' } };
    }
    if ((m = a.match(/^api -X PUT repos\/LLSLtd\/release-manifests\/contents\/(releases\/[\d-]+\.json)/))) {
      const body = input(args), cur = files.get(m[1]);
      if (cur && body.sha !== cur.sha) return { data: { message: 'does not match', status: '409' } };
      if (!cur && body.sha) return { data: { message: 'Not Found', status: '404' } };
      const sha = 's' + n++; files.set(m[1], { sha, content: body.content }); return { data: { content: { sha } } };
    }
    if ((m = a.match(/^api repos\/(o\/front)\/pulls\/(\d+)$/))) return { data: prs[m[1] + '#' + m[2]] };
    if (a.includes('-X PATCH') && a.includes('pulls/9')) { prs['o/front#9'].body = input(args).body; return { data: {} }; }
    if (a.includes('actions/workflows/d.yml/runs')) return { data: { workflow_runs: [{ status: 'completed', conclusion: 'success', html_url: 'run1', updated_at: 't' }] } };
    // rollback
    if (a.includes('repos/o/front/branches/master')) return { data: { commit: { sha: 'm9' } } };
    if (a.includes('repos/o/front/compare/m1...m9')) return { data: { files: [{ filename: 'server/migrations/007-add-col.js' }, { filename: 'src/app.js' }] } };
    if (a.includes('repos/o/front/git/commits/m1')) return { data: { tree: { sha: 'tree1' } } };
    if (a.includes('-X POST repos/o/front/git/commits')) { const b = input(args); assert.deepStrictEqual([b.tree, b.parents[0]], ['tree1', 'm9']); return { data: { sha: 'rb1' } }; }
    if (a.includes('-X POST repos/o/front/git/refs')) { assert.ok(input(args).ref.startsWith('refs/heads/rollback/')); return { data: { ref: 'x' } }; }
    if (a.includes('-X POST repos/o/front/pulls')) { const b = input(args); assert.strictEqual(b.base, 'master'); assert.ok(b.body.includes('server/migrations/007-add-col.js'), 'the PR warns about the migration'); return { data: { number: 77, html_url: 'u77' } }; }
    return { error: 'unexpected ' + a };
  };
  const h = createHistory({ ghJson: gh, writeTmp, push: (p) => { state = { ...state, ...p }; }, getState: () => state, org: () => 'LLSLtd',
    signoffOf: async (repo, num) => ({ pr: prs[repo + '#' + num], signers: [{ login: 'alice' }, { login: 'bob' }] }),
    requestReviews: async () => {}, whoAmI: async () => ({ github: 'alice', clickup: '1' }), send: (m) => toasts.push(m.text) });

  // empty repo → empty history
  await h.load();
  assert.deepStrictEqual(state.history.items, []);

  // a release run → a pending manifest, and its PR tagged with the release id
  const run = { rows: [{ env: 'prod', repo: 'o/front', label: 'frontend', source: 'dev', target: 'master', pr: { number: 9, url: 'u9' }, deploy: 'd.yml' }] };
  const id = await h.recordRun(run, { opener: { login: 'alice', clickup: '1' }, manual: [], flags: null });
  assert.ok(/^\d{4}-\d{2}-\d{2}-01$/.test(id), id);
  assert.strictEqual(state.history.items[0].status, 'pending');
  assert.ok(prs['o/front#9'].body.includes(`<!-- release-id:${id} -->`));
  // the same PRs again → the same manifest, not a second one
  assert.strictEqual(await h.recordRun(run, { opener: { login: 'alice' }, manual: [], flags: null }), id);
  assert.strictEqual(files.size, 1);

  // merged on GitHub → reconcile folds the merge commit, signers and the deploy result in
  Object.assign(prs['o/front#9'], { state: 'closed', merged: true, merge_commit_sha: 'm1', merged_at: 't' });
  await h.reconcile();
  const m = state.history.items[0];
  assert.deepStrictEqual([m.status, m.repos[0].mergeSha, m.repos[0].signers.join(',')], ['deployed', 'm1', 'alice,bob']);

  // rollback to it: one commit with the release's tree on top of today's prod, as a rollback PR
  await h.rollback(id);
  assert.ok(toasts.some(t => /Rollback to .*1 PR opened.*data changes in frontend/.test(t)), toasts.join(' | '));
  const rb = state.history.items.find(x => x.kind === 'rollback');
  assert.deepStrictEqual([rb.rollbackOf, rb.status, rb.repos[0].pr.number], [id, 'pending', 77]);
  console.log('release-history: all passed');
})().catch(e => { console.error(e); process.exit(1); });
