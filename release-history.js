// Release history, main-process side: reads and writes the manifests in the org's
// release-manifests repo (manifest-core.js builds them). Everyone's Overlord keeps them current:
// signatures, merges and deploy results are folded in as they're seen and written back with the
// file's sha, so two writers can't clobber each other (the loser just re-reads next time).
// Rollback restores a release's exact prod commits as signed rollback PRs, entirely through the
// GitHub API (no local clones).

const M = require('./manifest-core');

const HISTORY_SHOWN = 30;
// Files whose effects live in the database, not the code: a rollback can't undo them
const DATA_CHANGE = /(^|\/)(migrations?|migrate)\/|\.sql$|(^|\/)(schema|schemas)\//i;

module.exports = function createHistory({ ghJson, writeTmp, push, getState, org, signoffOf, requestReviews, whoAmI, send, teamKnown = () => true, findTicket = async () => null, ticketRepo = () => null }) {
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
    // a failed read (rate limit, network) keeps what we had: an empty history would make every release
    // look unsigned for a moment and pop the sign prompt
    if (files.error) { const prev = getState().history; return push({ history: { ...(prev || {}), error: prev && prev.items && prev.items.length ? null : files.error, items: (prev && prev.items) || [] } }); }
    const recent = files.sort((a, b) => b.name.localeCompare(a.name)).slice(0, HISTORY_SHOWN);
    const entries = (await Promise.all(recent.map(read))).filter(Boolean);
    push({ history: { repo: repoOf(), items: entries.map(e => e.manifest), loadedAt: Date.now(), error: null } });
    return { files, entries };
  }

  // After a release run: record it, one release per env (prod is the signed one; alpha / staging get their
  // own records so anyone can follow and manage them too). A still-pending record of that env that already
  // holds one of these PRs is the same release (re-run to add repos / refresh) — update it; else a new one.
  async function recordRun(run, { opener, manual, flags }) {
    if (!repoOf()) return null;
    const envs = [...new Set(run.rows.filter(r => r.pr && !r.merged && !r.closed).map(r => r.env))];
    let prodId = null;
    for (const env of envs) {
      const id = await recordEnv(run, env, { opener, manual: (manual || []).filter(m => (m.env || 'prod') === env), flags: env === 'prod' ? flags : null });
      if (env === 'prod') prodId = id;
    }
    return prodId;
  }
  async function recordEnv(run, env, { opener, manual, flags }) {
    const rows = run.rows.filter(r => r.env === env && r.pr && !r.merged && !r.closed);
    if (!rows.length) return null;
    const loaded = await load();
    if (!loaded) return null;
    const key = (r) => r.repo + '#' + r.pr.number;
    const mine = new Set(rows.map(key));
    const existing = loaded.entries.find(e => e.manifest.status === 'pending' && (e.manifest.env || 'prod') === env && e.manifest.repos.some(r => mine.has(key(r))));
    for (let attempt = 0; attempt < 4; attempt++) {
      let m, sha = null;
      if (existing) {
        m = existing.manifest; sha = existing.sha;
        const have = new Set(m.repos.map(key));
        const add = M.newManifest({ id: m.id, env, rows: rows.filter(r => !have.has(key(r))) }).repos;
        m = { ...m, repos: m.repos.concat(add), manual, flags: flags && flags.missing ? { missing: flags.missing } : m.flags, updatedAt: new Date().toISOString() };
      } else {
        m = M.newManifest({ id: M.nextId(loaded.files.map(f => f.name).concat(attempt ? [M.nextId(loaded.files.map(f => f.name))] : [])), env, rows, opener, manual, flags });
      }
      const w = await write(m, sha, existing ? `release ${m.id}: updated` : `release ${m.id} (${env}): opened by @${opener && opener.login}`);
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
  // Every PR is read at once, and a change shows here before its write lands (writes are the slow part).
  // of the commits signatures name, the PR's head if one covers it, else the latest signature's
  function signedShaOf(s) {
    const shas = (s.signers || []).map(x => x.sha).filter(Boolean);
    if (!shas.length || !s.pr || !s.pr.head) return undefined;
    return shas.includes(s.pr.head.sha) ? s.pr.head.sha : shas[shas.length - 1];
  }
  // a release PR's merged PRs: GitHub's "Merge pull request #N from …" commits, with the PR title (its 3rd line)
  async function changesOf(repo, n) {
    const r = await ghJson(['api', '-X', 'GET', `repos/${repo}/pulls/${n}/commits`, '-f', 'per_page=100']);
    if (apiErr(r) || !Array.isArray(r.data)) return null;
    const out = [];
    for (const c of r.data) {
      const msg = (c.commit && c.commit.message) || '', m = msg.match(/^Merge pull request #(\d+) from \S+/);
      if (!m) continue;
      const title = msg.split('\n').slice(1).map(x => x.trim()).filter(Boolean)[0] || '';
      if (/^chore\((release|merge)\)/i.test(title)) continue; // release / back-merge plumbing, not a change
      out.push({ n: +m[1], title: title.slice(0, 140) });
    }
    return out.slice(-60);
  }
  async function reconcile() {
    const loaded = await load();
    if (!loaded) return;
    const show = (m) => {
      const h = getState().history;
      if (h && h.items) push({ history: { ...h, items: h.items.map(x => x.id === m.id ? m : x) } });
    };
    // the ClickUp release ticket: the ticket repo merged in a release from the last 3 days, and no link yet
    const tr = ticketRepo();
    const wantsTicket = (m) => tr && !m.ticket && Date.now() - Date.parse(m.updatedAt || m.openedAt) < 3 * 86400e3 && m.repos.some(r => r.repo === tr && r.mergeSha);
    const wrote = await Promise.all(loaded.entries.filter(e => ['pending', 'merged', 'partial'].includes(e.manifest.status) || wantsTicket(e.manifest)).map(async ({ manifest, sha }) => {
      const seen = await Promise.all(manifest.repos.map(async (r) => {
        const out = { r };
        if (!r.mergeSha && !r.closed) out.s = await signoffOf(r.repo, r.pr.number);
        return out;
      }));
      let m = manifest, changed = false, c;
      for (const { r, s } of seen) {
        if (!s || s.error || !s.pr) continue;
        [m, c] = M.applyPr(m, r.repo, { number: r.pr.number, mergeSha: s.pr.merged ? s.pr.merge_commit_sha : null, mergedAt: s.pr.merged_at,
          closed: s.pr.state === 'closed', headSha: s.pr.head && s.pr.head.sha,
          // signers only from an Overlord that knows the approvers team: one that doesn't sees nobody as
          // signed, and would flip the record back and forth with every approver's Overlord
          signers: teamKnown() ? s.signers.map(x => x.login) : undefined,
          // the newest commit a signature covers: commits after it shipped unreviewed (shown on the card)
          signedSha: signedShaOf(s) });
        changed = changed || c;
      }
      if (changed) show(m);
      // what changed in each repo: the PRs its release PR brought in (merge commits' "#N title"), once, after it merges
      const noChanges = m.repos.filter(r => r.mergeSha && !r.changes);
      if (noChanges.length) {
        const lists = await Promise.all(noChanges.map(r => changesOf(r.repo, r.pr.number)));
        noChanges.forEach((r, i) => { if (lists[i]) { m = { ...m, repos: m.repos.map(x => x === r || (x.repo === r.repo && x.pr.number === r.pr.number) ? { ...x, changes: lists[i] } : x) }; changed = true; } });
      }
      const deploys = await Promise.all(m.repos.filter(r => r.mergeSha && r.deploy && !['success', 'failure'].includes(r.deploy.state)).map(async (r) => {
        const runs = await ghJson(['api', '-X', 'GET', `repos/${r.repo}/actions/workflows/${r.deploy.workflow}/runs`, '-f', `head_sha=${r.mergeSha}`, '-f', 'per_page=5']);
        const list = (runs.data && runs.data.workflow_runs) || [];
        return [r, list.find(x => x.status === 'completed'), list.find(x => x.status !== 'completed')];
      }));
      for (const [r, done, live] of deploys) {
        // still running: where to watch it, since when, and how long it usually takes (its last good runs)
        if (!done && live && (!r.deploy.runUrl || r.deploy.runUrl !== live.html_url)) {
          const ok = await ghJson(['api', '-X', 'GET', `repos/${r.repo}/actions/workflows/${r.deploy.workflow}/runs`, '-f', 'status=success', '-f', 'per_page=5']);
          const durs = ((ok.data && ok.data.workflow_runs) || []).map(x => Date.parse(x.updated_at) - Date.parse(x.run_started_at || x.created_at)).filter(x => x > 0).sort((a, b) => a - b);
          m = { ...m, repos: m.repos.map(x => x.repo === r.repo && x.pr.number === r.pr.number ? { ...x, deploy: { ...x.deploy, runUrl: live.html_url, startedAt: live.run_started_at || live.created_at, typicalMs: durs.length ? durs[Math.floor(durs.length / 2)] : null } } : x) };
          changed = true;
        }
        if (!done) continue;
        [m, c] = M.applyDeploy(m, r.repo, { state: done.conclusion === 'success' ? 'success' : 'failure', url: done.html_url, at: done.updated_at });
        changed = changed || c;
      }
      if (wantsTicket(m)) {
        const t = await findTicket(m.repos.find(r => r.repo === tr).mergeSha).catch(() => null);
        if (t) { const v = String(t.name).match(/\bv(\d[\w.]*)/); m = { ...m, ticket: t, ...(v ? { version: v[1] } : {}) }; changed = true; }
      }
      if (!changed) return false;
      show(m);
      const w = await write(m, sha);
      return !!w.sha;
    }));
    if (wrote.some(Boolean)) await load();
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
    const warnings = [];
    for (const p of plan) {
      // what restoring code can't undo: data migrations, schema files, a dbschemas bump since then
      const since = await ghJson(['api', `repos/${p.repo}/compare/${p.toSha}...${p.fromSha}`]);
      const risky = ((since.data && since.data.files) || []).filter(f => DATA_CHANGE.test(f.filename)
        || (/(^|\/)package\.json$/.test(f.filename) && /@llsltd\/dbschemas/.test(f.patch || ''))).map(f => f.filename);
      const warn = risky.length ? { repo: p.repo, label: p.label, files: risky } : null;
      if (warn) warnings.push(warn);
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
          ...(warn ? [`> ⚠ **Data changes since that release are NOT rolled back** — check them by hand: ${warn.files.map(x => '`' + x + '`').join(', ')}`, ''] : []),
          `_Opened by Overlord's Rollback._`, '', require('./signoff-core').openerMark(who.github, who.clickup, made.data.sha), M.releaseIdMark(rbId)].join('\n') })]);
      if (apiErr(pr)) { send({ type: 'toast', text: `Rollback ${p.label}: ${apiErr(pr)}` }); continue; }
      await requestReviews(p.repo, pr.data.number);
      const src = target.repos.find(r => r.repo === p.repo);
      rows.push({ repo: p.repo, label: p.label, source: branch, target: p.target, pr: { number: pr.data.number, url: pr.data.html_url },
        baseSha: p.fromSha, headSha: made.data.sha, deploy: src && src.deploy ? src.deploy.workflow : null });
    }
    if (!rows.length) return;
    const m = M.newManifest({ id: rbId, kind: 'rollback', rollbackOf: id, rows, opener: { login: who.github, clickup: who.clickup } });
    if (warnings.length) m.warnings = warnings;
    const w = await write(m, null, `rollback ${rbId}: restore release ${id}, opened by @${who.github}`);
    if (w.error) send({ type: 'toast', text: 'Rollback manifest: ' + w.error });
    await load();
    send({ type: 'toast', text: `Rollback to ${id}: ${rows.length} PR${rows.length === 1 ? '' : 's'} opened — needs 2 signatures to merge`
      + (warnings.length ? ` · ⚠ data changes in ${warnings.map(w => w.label).join(', ')} are not rolled back` : '') });
  }

  // Import past prod releases from merged release PRs (source → prod) of every prod step, when the
  // history is empty. Deploy results fill in on the next reconcile.
  async function importPast(steps) {
    const loaded = await load();
    if (!loaded) return;
    if (loaded.files.length) return send({ type: 'toast', text: 'History already has releases: import is only for an empty history' });
    const prs = [];
    await Promise.all(steps.map(async (s) => {
      const r = await ghJson(['api', '-X', 'GET', `repos/${s.repo}/pulls`, '-f', 'state=closed', '-f', `base=${s.target}`, '-f', 'per_page=50']);
      for (const p of (Array.isArray(r.data) ? r.data : [])) {
        if (!p.merged_at || !p.head || p.head.ref !== s.source) continue;
        prs.push({ repo: s.repo, label: s.label, source: s.source, target: s.target, deploy: s.deploy, number: p.number, url: p.html_url,
          mergedAt: p.merged_at, mergeSha: p.merge_commit_sha, baseSha: p.base && p.base.sha, headSha: p.head.sha, author: p.user && p.user.login });
      }
    }));
    const past = M.groupPast(prs);
    let wrote = 0;
    for (const m of past) {
      const w = await write(m, null, `release ${m.id}: imported from merged release PRs`);
      if (w.sha) wrote++;
    }
    await load();
    send({ type: 'toast', text: wrote ? `Imported ${wrote} past release${wrote === 1 ? '' : 's'}: deploy results fill in shortly` : 'No past release PRs found' });
  }

  // confirmed.json: per 'repo|env' the last hand deploy someone confirmed ({ sha, at, by, release }).
  const CONFIRMED = 'confirmed.json';
  let confirmedCache = null; // { sha, data }
  async function readConfirmed() {
    const r = await ghJson(['api', `repos/${repoOf()}/contents/${CONFIRMED}?ref=main`]);
    if (apiErr(r)) return /404|empty/i.test(apiErr(r)) ? { sha: null, data: {} } : { error: apiErr(r) };
    if (confirmedCache && confirmedCache.sha === r.data.sha) return confirmedCache;
    try { confirmedCache = { sha: r.data.sha, data: JSON.parse(Buffer.from(r.data.content, 'base64').toString('utf8')) }; } catch { confirmedCache = { sha: r.data.sha, data: {} }; }
    return confirmedCache;
  }
  async function confirmed() {
    if (!repoOf()) return {};
    const c = await readConfirmed();
    return c.error ? {} : c.data;
  }
  // items: [{ repo, env, sha }]
  async function confirm(items, by, release) {
    if (!repoOf() || !items.length) return;
    for (let attempt = 0; attempt < 4; attempt++) {
      const cur = await readConfirmed();
      if (cur.error) throw new Error(cur.error);
      const data = { ...cur.data };
      for (const x of items) data[`${x.repo}|${x.env}`] = { sha: x.sha, at: new Date().toISOString(), by: by || null, release: release || null };
      const r = await ghJson(['api', '-X', 'PUT', `repos/${repoOf()}/contents/${CONFIRMED}`, '--input', writeTmp({
        message: `deployed by hand: ${items.map(x => x.repo.split('/')[1] + ' ' + x.env).join(', ')}${by ? ' (@' + by + ')' : ''}`, branch: 'main', ...(cur.sha ? { sha: cur.sha } : {}),
        content: Buffer.from(JSON.stringify(data, null, 2) + '\n').toString('base64'),
      })]);
      const e = apiErr(r);
      if (!e) { confirmedCache = { sha: r.data && r.data.content && r.data.content.sha, data }; return; }
      if (!/409|422|does not match/i.test(e)) throw new Error(e);
    }
    throw new Error('confirmed.json kept changing: try again');
  }

  // running.json: the one Release all running across the team ({ by, beat, id, wave, waves, status, detail, merged })
  const RUNNING = 'running.json';
  async function readRunning() {
    const r = await ghJson(['api', `repos/${repoOf()}/contents/${RUNNING}?ref=main`]);
    if (apiErr(r)) return /404|empty/i.test(apiErr(r)) ? { sha: null, data: null } : { error: apiErr(r) };
    try { return { sha: r.data.sha, data: JSON.parse(Buffer.from(r.data.content, 'base64').toString('utf8')) }; } catch { return { sha: r.data.sha, data: null }; }
  }
  async function running() {
    if (!repoOf()) return null;
    const r = await readRunning();
    return r.error ? null : r.data;
  }
  // data null = done: the file goes
  async function setRunning(data) {
    if (!repoOf()) return;
    for (let attempt = 0; attempt < 3; attempt++) {
      const cur = await readRunning();
      if (cur.error) return;
      if (!data && !cur.sha) return;
      const r = data
        ? await ghJson(['api', '-X', 'PUT', `repos/${repoOf()}/contents/${RUNNING}`, '--input', writeTmp({ message: `release all: @${data.by} · wave ${data.wave}/${data.waves} ${data.status}`,
            branch: 'main', ...(cur.sha ? { sha: cur.sha } : {}), content: Buffer.from(JSON.stringify(data, null, 2) + '\n').toString('base64') })])
        : await ghJson(['api', '-X', 'DELETE', `repos/${repoOf()}/contents/${RUNNING}`, '--input', writeTmp({ message: 'release all: finished', branch: 'main', sha: cur.sha })]);
      const e = apiErr(r);
      if (!e || !/409|422|does not match/i.test(e)) return;
    }
  }

  // A run's findings per prod PR, into its pending manifest (only what changed is written)
  async function recordHealth(rows) {
    const key = (r) => r.repo + '#' + r.pr.number;
    const found = new Map((rows || []).filter(r => r.pr && !r.running).map(r => [key(r), {
      status: r.status || null, checks: r.checks || null, conflict: r.conflict == null ? null : r.conflict,
      backMerge: r.backMerge && r.backMerge.number ? { number: r.backMerge.number, url: r.backMerge.url, conflict: !!r.backMerge.conflict } : null,
      dbschemas: r.dbschemas && r.dbschemas.used && r.dbschemas.used.length ? r.dbschemas.used : null, error: r.error || null }]));
    if (!found.size) return;
    const loaded = await load();
    if (!loaded) return;
    for (const { manifest, sha } of loaded.entries) {
      if (manifest.status !== 'pending') continue;
      let changed = false;
      const repos = manifest.repos.map(r => {
        const h = found.get(key(r));
        if (!h || JSON.stringify(h) === JSON.stringify(r.health || null)) return r;
        changed = true;
        return { ...r, health: h };
      });
      if (changed) await write({ ...manifest, repos, updatedAt: new Date().toISOString() }, sha, `release ${manifest.id}: checks`);
    }
  }

  // Cancel: mark the pending release(s) holding these PRs ('repo#n') as called off by `by`
  async function markCancelled(prKeys, by) {
    const keys = new Set(prKeys);
    for (let attempt = 0; attempt < 3; attempt++) {
      const loaded = await load();
      if (!loaded) return;
      let conflict = false;
      for (const { manifest, sha } of loaded.entries) {
        if (manifest.status !== 'pending' || !manifest.repos.some(r => keys.has(r.repo + '#' + r.pr.number))) continue;
        const w = await write(M.cancel(manifest, by), sha, `release ${manifest.id}: cancelled by @${by}`);
        if (w.conflict) conflict = true;
      }
      if (!conflict) return load();
    }
  }

  // Sign: record `who` on the release itself, so PRs added to it later are covered too
  async function markSigned(ids, who) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const loaded = await load();
      if (!loaded) return;
      let conflict = false;
      for (const { manifest, sha } of loaded.entries) {
        if (!ids.includes(manifest.id) || (manifest.signedBy || []).some(x => x.login.toLowerCase() === who.login.toLowerCase())) continue;
        const m = { ...manifest, signedBy: (manifest.signedBy || []).concat({ login: who.login, clickup: who.clickup || null, at: new Date().toISOString() }), updatedAt: new Date().toISOString() };
        const w = await write(m, sha, `release ${m.id}: signed by @${who.login}`);
        if (w.conflict) conflict = true;
      }
      if (!conflict) return load();
    }
  }

  return { load, recordRun, reconcile, rollback, importPast, confirmed, confirm, running, setRunning, recordHealth, markCancelled, markSigned };
};
