// Deterministic release: for each (repo, source → target) of a release plan, open or reuse the
// release PR, open a back-merge PR when the target carries hotfixes the source lacks, and report
// whether each PR is mergeable and green. No agent — an agent is only started on demand, per
// blocked row (the Fix button). gh = ghJson (never rejects; { data } | { error }).
// Self-check: release-run.test.js

const CI_DEPLOY = /^ci\(deploy\)/i;
const firstLine = (m) => String(m || '').split('\n')[0];
const MAX_TOP_AREAS = 8;

// Real commits the target has and the source doesn't: single-parent, minus deploy-bot commits.
function hotfixTitles(compareCommits) {
  return (compareCommits || []).filter(c => (c.parents || []).length === 1)
    .map(c => firstLine(c.commit && c.commit.message)).filter(t => !CI_DEPLOY.test(t));
}

// The release PR body: what merging deploys, how much, by type, by area.
function releaseBody({ env, source, target, workflow, ahead, titles, hotfixes }) {
  const L = [];
  L.push(`Promotes \`${source}\` → \`${target}\` (**${env}**)${workflow ? `: merging deploys via \`${workflow}\`` : ''}.`, '');
  L.push(`**${ahead} commit${ahead === 1 ? '' : 's'}** (${titles.length} non-merge${ahead > 250 ? ', first 250 compared' : ''})`);
  if (hotfixes.length) {
    L.push('', `> ⚠ \`${target}\` has ${hotfixes.length} commit${hotfixes.length === 1 ? '' : 's'} \`${source}\` lacks: merge the back-merge PR (\`${target}\` → \`${source}\`) first.`);
  }
  const types = {}, areas = {};
  for (const t of titles) {
    const m = t.match(/^(\w+)(?:\(([^)]+)\))?!?:\s*(.*)$/);
    const type = m ? m[1].toLowerCase() : 'other';
    types[type] = (types[type] || 0) + 1;
    const area = (m && m[2]) || 'general';
    const line = m ? m[3] : t;
    (areas[area] = areas[area] || []);
    if (!areas[area].includes(line)) areas[area].push(line); // the same change landed twice (commit + its copy)
  }
  const byType = Object.entries(types).sort((a, b) => b[1] - a[1]);
  if (byType.length) L.push('', '### By type', byType.map(([k, n]) => `\`${k}\` ${n}`).join(' · '));
  const byArea = Object.entries(areas).sort((a, b) => b[1].length - a[1].length);
  if (byArea.length) {
    L.push('', '### Highlights by area');
    for (const [area, list] of byArea.slice(0, MAX_TOP_AREAS)) {
      L.push(`- **${area}** (${list.length}): ${list.slice(0, 2).join('; ')}${list.length > 2 ? '; …' : ''}`);
    }
    if (byArea.length > MAX_TOP_AREAS) L.push(`- also: ${byArea.slice(MAX_TOP_AREAS).map(([a, l]) => `${a} (${l.length})`).join(', ')}`);
  }
  L.push('', '_Opened by Overlord\'s Release button._');
  return L.join('\n');
}

const BAD = ['failure', 'timed_out', 'action_required', 'startup_failure'];
const BAD_STATUS = ['failure', 'error'];
// Everything red on a commit, by name: check runs (Actions, apps) and commit statuses (Snyk & co).
const failingNames = (runs, combined) => [
  ...(runs || []).filter(r => BAD.includes(r.conclusion)).map(r => r.name),
  ...((combined && combined.statuses) || []).filter(s => BAD_STATUS.includes(s.state)).map(s => s.context),
];

// Check runs + commit statuses on the PR head → 'fail' | 'pending' | 'pass' | 'none'. known =
// names that also fail on the target branch: red before this release, so not its fault.
function checksState(checkRuns, combined, known) {
  const skip = new Set(known || []);
  const runs = (checkRuns || []).filter(r => !skip.has(r.name));
  const statuses = ((combined && combined.statuses) || []).filter(s => !skip.has(s.context));
  if (runs.some(r => BAD.includes(r.conclusion)) || statuses.some(s => BAD_STATUS.includes(s.state))) return 'fail';
  if (runs.some(r => r.status !== 'completed') || statuses.some(s => s.state === 'pending')) return 'pending';
  return runs.length || statuses.length ? 'pass' : 'none';
}

// A row's headline from its parts.
function rowStatus(r) {
  if (r.error) return 'error';
  if (r.nothing) return 'nothing';
  if (r.merged) return 'merged';
  if (r.closed) return 'closed';
  if (r.conflict === true || r.checks === 'fail' || (r.backMerge && r.backMerge.conflict)) return 'blocked';
  return 'ok';
}

const sleep = (ms) => new Promise(res => setTimeout(res, ms));

// Check names the branch's protection requires ([] when unprotected or not readable).
function requiredChecks(branch) {
  const rsc = branch && branch.protection && branch.protection.required_status_checks;
  if (!rsc) return [];
  return [...new Set([...(rsc.contexts || []), ...((rsc.checks || []).map(c => c.context))])];
}

// Is PR #n mergeable, and are its checks green? conflict: true | false | null (GitHub still
// computing — unknown, not "fine"). Checks that also fail on the target branch were red before
// this release and don't count (knownFailing).
async function prHealth(gh, repo, n, target, wait = sleep) {
  const api = (...a) => gh(['api', ...a]);
  let st = null;
  for (let i = 0; i < 6 && !st; i++) {
    const r = await api(`repos/${repo}/pulls/${n}`);
    if (r.data && r.data.state === 'closed') return { closed: true, merged: !!r.data.merged };
    if (r.data && r.data.mergeable !== null && r.data.mergeable !== undefined) st = r.data;
    else await wait(1500);
  }
  const conflict = st ? st.mergeable === false : null;
  let checks = 'none', knownFailing = [], advisory = [];
  const sha = st && st.head && st.head.sha;
  if (sha) {
    const [runs, status, baseRuns, baseStatus, branch] = await Promise.all([
      api('-X', 'GET', `repos/${repo}/commits/${sha}/check-runs`, '-f', 'per_page=100'),
      api(`repos/${repo}/commits/${sha}/status`),
      api('-X', 'GET', `repos/${repo}/commits/${target}/check-runs`, '-f', 'per_page=100'),
      api(`repos/${repo}/commits/${target}/status`),
      api(`repos/${repo}/branches/${target}`),
    ]);
    const headRuns = runs.data && runs.data.check_runs, headStatus = status.data;
    const failing = failingNames(headRuns, headStatus);
    const req = requiredChecks(branch.data);
    if (req.length) {
      // the target's branch protection names what must pass: only those block, the rest advise
      checks = checksState((headRuns || []).filter(r => req.includes(r.name)),
        { statuses: ((headStatus && headStatus.statuses) || []).filter(x => req.includes(x.context)) });
      advisory = failing.filter(x => !req.includes(x));
    } else {
      // nothing required: our CI (check runs) blocks unless it was already red on the target;
      // external commit statuses (Snyk & co.) only advise, since nothing makes them gate a merge
      const onTarget = new Set(failingNames(baseRuns.data && baseRuns.data.check_runs, baseStatus.data));
      knownFailing = failing.filter(x => onTarget.has(x));
      checks = checksState(headRuns, null, knownFailing);
      advisory = failingNames(null, headStatus).filter(x => !onTarget.has(x));
    }
  }
  return { conflict, checks, knownFailing, advisory };
}

// One (repo, env, source → target) row. update(patch) streams progress to the UI.
async function releaseRow(gh, row, { writeJson, update, wait = sleep }) {
  const { repo, source, target } = row;
  const api = (...a) => gh(['api', ...a]);
  // GitHub's `head=owner:branch` filter silently returns nothing on some repos (seen on
  // frontline.io-web), so list the base's open PRs and match the head branch here.
  const findOpen = async (base, head) => {
    const r = await api('-X', 'GET', `repos/${repo}/pulls`, '-f', 'state=open', '-f', `base=${base}`, '-f', 'per_page=100');
    if (r.error) return { error: r.error };
    const same = (p) => p.head && p.head.ref === head && (!p.head.repo || p.head.repo.full_name.toLowerCase() === repo.toLowerCase());
    return { pr: (r.data || []).find(same) || null };
  };
  const open = async (payload) => {
    const r = await api('-X', 'POST', `repos/${repo}/pulls`, '--input', writeJson(payload));
    return r.error || !r.data || !r.data.number ? { error: r.error || (r.data && r.data.message) || 'could not open PR' } : { pr: r.data };
  };
  const cmp = await api(`repos/${repo}/compare/${target}...${source}`);
  if (cmp.error || !cmp.data) return { error: cmp.error || 'compare failed' };
  const ahead = cmp.data.ahead_by, files = (cmp.data.files || []).length;
  if (!ahead || !files) return { nothing: true, ahead };
  const titles = (cmp.data.commits || []).filter(c => (c.parents || []).length === 1).map(c => firstLine(c.commit.message));
  const back = await api(`repos/${repo}/compare/${source}...${target}`);
  const hotfixes = back.data ? hotfixTitles(back.data.commits) : [];
  update({ ahead, hotfixes: hotfixes.length });

  // the release PR: reuse an open one, else open it
  let found = await findOpen(target, source);
  if (found.error) return { error: found.error };
  let pr = found.pr, reused = !!pr, lastBody = null;
  if (!pr) {
    lastBody = releaseBody({ env: row.env, source, target, workflow: row.deploy, ahead, titles, hotfixes });
    const made = await open({ title: `chore(release): promote ${source} to ${target}`, head: source, base: target, body: lastBody });
    if (made.error) return { error: made.error, ahead };
    pr = made.pr;
  }
  update({ pr: { number: pr.number, url: pr.html_url }, reused });

  // back-merge when the target carries real hotfixes
  let backMerge = null;
  if (hotfixes.length) {
    const bf = await findOpen(source, target);
    let bpr = bf.pr;
    if (!bpr && !bf.error) {
      const made = await open({ title: `chore(merge): align ${source} with ${target}`, head: target, base: source,
        body: [`Gates the release PR #${pr.number} (${pr.html_url}): merge this first.`, '',
          `\`${target}\` carries ${hotfixes.length} commit${hotfixes.length === 1 ? '' : 's'} \`${source}\` lacks:`,
          ...hotfixes.map(t => `- ${t}`), '', '_Opened by Overlord\'s Release button._'].join('\n') });
      bpr = made.pr;
      if (made.error) backMerge = { error: made.error };
    }
    if (bpr) {
      const h = await prHealth(gh, repo, bpr.number, source, wait);
      backMerge = { number: bpr.number, url: bpr.html_url, conflict: h.conflict === true };
    }
    update({ backMerge });
  }

  // is the release PR mergeable, and are its checks green?
  const health = await prHealth(gh, repo, pr.number, target, wait);
  return { ahead, hotfixes: hotfixes.length, pr: { number: pr.number, url: pr.html_url }, reused, body: reused ? null : lastBody, backMerge, ...health };
}

// Every row in parallel; onRow(i, row) after each change.
async function runRelease(gh, prs, { writeJson, onRow, wait }) {
  const rows = prs.map(p => ({ ...p, running: true }));
  await Promise.all(rows.map(async (row, i) => {
    const update = (patch) => { Object.assign(row, patch); onRow(i, row); };
    let res;
    try { res = await releaseRow(gh, row, { writeJson, update, wait }); } catch (e) { res = { error: e.message || String(e) }; }
    Object.assign(row, res, { running: false });
    row.status = rowStatus(row);
    onRow(i, row);
  }));
  return rows;
}

module.exports = { hotfixTitles, releaseBody, checksState, requiredChecks, rowStatus, prHealth, releaseRow, runRelease };
