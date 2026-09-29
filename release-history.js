// Release history, main-process side: reads and writes the manifests in the org's
// release-manifests repo (manifest-core.js builds them). Everyone's Overlord keeps them current:
// signatures, merges and deploy results are folded in as they're seen and written back with the
// file's sha, so two writers can't clobber each other (the loser just re-reads next time).
// Rollback restores a release's exact prod commits as signed rollback PRs, entirely through the
// GitHub API (no local clones).

const M = require('./manifest-core');

const HISTORY_SHOWN = 30;

module.exports = function createHistory({ ghJson, writeTmp, push, getState, org, signoffOf, requestReviews, whoAmI, send }) {
  const repoOf = () => org() && `${org()}/${M.MANIFESTS_REPO}`;
  const apiErr = (r) => r.error || (r.data && !Array.isArray(r.data) && r.data.message && r.data.status ? `${r.data.message} (${r.data.status})` : null);
  const cache = new Map(); // path → { sha, manifest }

  async function list() {
    const r = await ghJson(['api', `repos/${repoOf()}/contents/${M.DIR}?ref=main`]);
    if (apiErr(r)) return /404|empty/i.test(apiErr(r)) ? [] : { error: apiErr(r) };
    return (Array.isArray(r.data) ? r.data : []).filter(f => f.name.endsWith('.json')).map(f => ({ name: f.name, path: f.path, sha: f.sha }));
  }

  async function read(file) {
    const hit = cache.get(file.path);
    if (hit && hit.sha === file.sha) return hit;
    const r = await ghJson(['api', `repos/${repoOf()}/contents/${file.path}?ref=main`]);
    if (apiErr(r) || !r.data || !r.data.content) return null;
    try {
      const entry = { sha: r.data.sha, manifest: JSON.parse(Buffer.from(r.data.content, 'base64').toString('utf8')) };
      cache.set(file.path, entry);
      return entry;
    } catch { return null; }
  }

  // Create (no sha) or update (sha) a manifest. { sha } | { conflict } | { error }
  async function write(m, sha, message) {
    const r = await ghJson(['api', '-X', 'PUT', `repos/${repoOf()}/contents/${M.manifestPath(m.id)}`, '--input', writeTmp({
      message: message || `release ${m.id}: ${m.status}`, branch: 'main', ...(sha ? { sha } : {}),
      content: Buffer.from(JSON.stringify(m, null, 2) + '\n').toString('base64'),
    })]);
    const e = apiErr(r);
    if (e) return /409|422|does not match|already exists/i.test(e) ? { conflict: true } : { error: e };
    const newSha = r.data && r.data.content && r.data.content.sha;
    cache.set(M.manifestPath(m.id), { sha: newSha, manifest: m });
    return { sha: newSha };
  }

  // The last HISTORY_SHOWN manifests, newest first, into state.history.
  async function load() {
    if (!repoOf()) return;
    const files = await list();
    if (files.error) return push({ history: { error: files.error, items: [] } });
    const recent = files.sort((a, b) => b.name.localeCompare(a.name)).slice(0, HISTORY_SHOWN);
    const entries = (await Promise.all(recent.map(read))).filter(Boolean);
    push({ history: { repo: repoOf(), items: entries.map(e => e.manifest), loadedAt: Date.now(), error: null } });
    return { files, entries };
  }

  // After a release run: record it. A still-pending manifest that already holds one of these PRs
  // is the same release (re-run to add repos / refresh) — update it; else a new one.
  async function recordRun(run, { opener, manual, flags }) {
    if (!repoOf()) return null;
    const rows = run.rows.filter(r => r.env === 'prod' && r.pr && !r.merged && !r.closed);
    if (!rows.length) return null;
    const loaded = await load();
    if (!loaded) return null;
    const key = (r) => r.repo + '#' + r.pr.number;
    const mine = new Set(rows.map(key));
    const existing = loaded.entries.find(e => e.manifest.status === 'pending' && e.manifest.repos.some(r => mine.has(key(r))));
    for (let attempt = 0; attempt < 4; attempt++) {
      let m, sha = null;
      if (existing) {
        m = existing.manifest; sha = existing.sha;
        const have = new Set(m.repos.map(key));
        const add = M.newManifest({ id: m.id, rows: rows.filter(r => !have.has(key(r))) }).repos;
        m = { ...m, repos: m.repos.concat(add), manual, flags: flags && flags.missing ? { missing: flags.missing } : m.flags, updatedAt: new Date().toISOString() };
      } else {
        m = M.newManifest({ id: M.nextId(loaded.files.map(f => f.name).concat(attempt ? [M.nextId(loaded.files.map(f => f.name))] : [])), rows, opener, manual, flags });
      }
      const w = await write(m, sha, existing ? `release ${m.id}: updated` : `release ${m.id}: opened by @${opener && opener.login}`);
      if (w.conflict) { await load(); continue; }
      if (w.error) { send({ type: 'toast', text: 'Release manifest: ' + w.error }); return null; }
      // tag every PR with its release id, so anyone's Overlord can tell which release it's in
      await Promise.all(rows.map(async (r) => {
        const cur = await ghJson(['api', `repos/${r.repo}/pulls/${r.pr.number}`]);
        const body = (cur.data && cur.data.body) || '';
        if (apiErr(cur) || M.releaseIdOf(body)) return;
        await ghJson(['api', '-X', 'PATCH', `repos/${r.repo}/pulls/${r.pr.number}`, '--input', writeTmp({ body: body + '\n' + M.releaseIdMark(m.id) })]);
      }));
      await load();
      return m.id;
    }
    return null;
  }

  // Fold what GitHub says now into every unfinished manifest; write back only what changed.
  async function reconcile() {
    const loaded = await load();
    if (!loaded) return;
    let wrote = false;
    for (const { manifest, sha } of loaded.entries) {
      if (!['pending', 'merged'].includes(manifest.status)) continue;
      let m = manifest, changed = false, c;
      for (const r of m.repos) {
        if (!r.mergeSha && !r.closed) {
          const s = await signoffOf(r.repo, r.pr.number);
          if (s.error || !s.pr) continue;
          [m, c] = M.applyPr(m, r.repo, { number: r.pr.number, mergeSha: s.pr.merged ? s.pr.merge_commit_sha : null, mergedAt: s.pr.merged_at,
            closed: s.pr.state === 'closed', headSha: s.pr.head && s.pr.head.sha, signers: s.signers.map(x => x.login) });
          changed = changed || c;
        }
        const cur = m.repos.find(x => x.repo === r.repo && x.pr.number === r.pr.number);
        if (cur.mergeSha && cur.deploy && !['success', 'failure'].includes(cur.deploy.state)) {
          const runs = await ghJson(['api', '-X', 'GET', `repos/${r.repo}/actions/workflows/${cur.deploy.workflow}/runs`, '-f', `head_sha=${cur.mergeSha}`, '-f', 'per_page=5']);
          const done = ((runs.data && runs.data.workflow_runs) || []).find(x => x.status === 'completed');
          if (done) {
            [m, c] = M.applyDeploy(m, r.repo, { state: done.conclusion === 'success' ? 'success' : 'failure', url: done.html_url, at: done.updated_at });
            changed = changed || c;
          }
        }
      }
      if (changed) { const w = await write(m, sha); wrote = wrote || !!w.sha; }
    }
    if (wrote) await load();
  }

  // Roll back to release `id`: per repo it merged (minus `skip`), a commit on top of the prod
  // branch whose files are exactly that release's merge commit, on rollback/<rollbackId>, as a PR
  // into prod. Signed and merged like any prod release; recorded as a 'rollback' manifest.
  async function rollback(id, skip = []) {
    const loaded = await load();
    const entry = loaded && loaded.entries.find(e => e.manifest.id === id);
    if (!entry) return send({ type: 'toast', text: `Release ${id} not found` });
    const target = entry.manifest;
    const heads = {};
    await Promise.all(target.repos.filter(r => r.mergeSha).map(async (r) => {
      const b = await ghJson(['api', `repos/${r.repo}/branches/${r.target}`]);
      if (b.data && b.data.commit) heads[r.repo] = b.data.commit.sha;
    }));
    const plan = M.rollbackPlan(target, heads, skip).filter(p => !p.noop && p.fromSha);
    if (!plan.length) return send({ type: 'toast', text: `Prod already matches release ${id}: nothing to roll back` });
    const who = await whoAmI();
    const rbId = M.nextId(loaded.files.map(f => f.name));
    const branch = `rollback/${rbId}`;
    const rows = [];
    for (const p of plan) {
      const commit = await ghJson(['api', `repos/${p.repo}/git/commits/${p.toSha}`]);
      if (apiErr(commit) || !commit.data.tree) { send({ type: 'toast', text: `Rollback ${p.label}: ${apiErr(commit) || 'no tree'}` }); continue; }
      const made = await ghJson(['api', '-X', 'POST', `repos/${p.repo}/git/commits`, '--input', writeTmp({
        message: `chore(rollback): restore ${p.target} to release ${id}\n\nFiles exactly as release ${id} left them (${p.toSha.slice(0, 7)}), on top of the current ${p.target} (${p.fromSha.slice(0, 7)}).`,
        tree: commit.data.tree.sha, parents: [p.fromSha] })]);
      if (apiErr(made)) { send({ type: 'toast', text: `Rollback ${p.label}: ${apiErr(made)}` }); continue; }
      const ref = await ghJson(['api', '-X', 'POST', `repos/${p.repo}/git/refs`, '--input', writeTmp({ ref: `refs/heads/${branch}`, sha: made.data.sha })]);
      if (apiErr(ref)) { send({ type: 'toast', text: `Rollback ${p.label}: ${apiErr(ref)}` }); continue; }
      const pr = await ghJson(['api', '-X', 'POST', `repos/${p.repo}/pulls`, '--input', writeTmp({
        title: `chore(rollback): restore ${p.target} to release ${id}`, head: branch, base: p.target,
        body: [`Rolls **${p.target}** back to release **${id}**: one commit whose files are exactly that release's (${p.toSha.slice(0, 7)}).`, '',
          `> Changes since then stay on the source branch — the next release brings them back unless they're reverted there too.`, '',
          `_Opened by Overlord's Rollback._`, '', require('./signoff-core').openerMark(who.github, who.clickup), M.releaseIdMark(rbId)].join('\n') })]);
      if (apiErr(pr)) { send({ type: 'toast', text: `Rollback ${p.label}: ${apiErr(pr)}` }); continue; }
      await requestReviews(p.repo, pr.data.number);
      const src = target.repos.find(r => r.repo === p.repo);
      rows.push({ repo: p.repo, label: p.label, source: branch, target: p.target, pr: { number: pr.data.number, url: pr.data.html_url },
        baseSha: p.fromSha, headSha: made.data.sha, deploy: src && src.deploy ? src.deploy.workflow : null });
    }
    if (!rows.length) return;
    const m = M.newManifest({ id: rbId, kind: 'rollback', rollbackOf: id, rows, opener: { login: who.github, clickup: who.clickup } });
    const w = await write(m, null, `rollback ${rbId}: restore release ${id}, opened by @${who.github}`);
    if (w.error) send({ type: 'toast', text: 'Rollback manifest: ' + w.error });
    await load();
    send({ type: 'toast', text: `Rollback to ${id}: ${rows.length} PR${rows.length === 1 ? '' : 's'} opened — needs 2 signatures to merge` });
  }

  return { load, recordRun, reconcile, rollback };
};
