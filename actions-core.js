// Pure helpers for GitHub Actions tracking. Shared by main.js (polling),
// index.html (badge + settings), and the node self-check in actions-core.test.js.
// No DOM, no gh, no electron — just data in, data out.

const REPO_RE = /^[\w.-]+\/[\w.-]+$/;

// Parse whatever the user pasted into { repo, file }. `file` is '' when they
// gave a repo rather than a specific workflow, which is the caller's cue to go
// list that repo's workflows instead of tracking one directly.
// Accepts: a workflow URL, a repo URL, or bare `owner/repo`.
function parseWorkflowInput(str) {
  const s = String(str || '').trim();
  if (!s) return null;
  const url = s.match(/^https?:\/\/(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+)(.*)$/i);
  if (url) {
    const repo = `${url[1]}/${url[2]}`;
    const wf = url[3].match(/\/actions\/workflows\/([\w.-]+\.ya?ml)/i);
    return { repo, file: wf ? wf[1] : '' };
  }
  if (/^https?:\/\//i.test(s)) return null; // some other host — not ours to guess at
  return REPO_RE.test(s) ? { repo: s, file: '' } : null;
}

// Collapse a GitHub run object's status/conclusion pair into one display state.
function runState(run) {
  if (!run || !run.status) return 'none';
  if (run.status !== 'completed') return 'running'; // queued, waiting, in_progress
  const c = run.conclusion;
  if (c === 'success') return 'success';
  if (c === 'cancelled' || c === 'skipped' || c === 'neutral') return 'cancelled';
  return 'failure'; // failure, timed_out, action_required, startup_failure
}

// Badge summary. Rows are { state, error? }. 'hidden' means render nothing.
// Precedence: any fetch error wins (a stale row must never read as "up to
// date"), then running, then failed, then the all-clear.
function actionsRollup(rows) {
  const list = rows || [];
  if (!list.length) return { cls: 'hidden', text: '' };
  const errs = list.filter(r => r.error).length;
  if (errs) return { cls: 'err', text: `Actions — ${errs} check failed` };
  const n = (s) => list.filter(r => r.state === s).length;
  const running = n('running'), failed = n('failure'), ok = n('success'), never = n('none');
  // The loud red badge is reserved for a failure that is MINE to fix. Someone
  // else's broken deploy still shows in the text and as a red row, it just
  // doesn't shout. `mine` undefined counts as mine — an unknown gh login must
  // fail loud, not silently swallow the alert.
  const myFailure = list.some(r => r.state === 'failure' && r.mine !== false);
  const parts = [];
  if (running) parts.push(`${running} running`);
  if (failed) parts.push(`${failed} failed`);
  if (ok) parts.push(`${ok} ok`);
  if (never) parts.push(`${never} never run`);
  if (running) return { cls: 'running', text: '' + parts.join(' · ') };
  if (failed) return { cls: myFailure ? 'alert' : 'warn', text: '' + parts.join(' · ') };
  if (ok && !never) return { cls: '', text: `All ${ok} up to date` };
  return { cls: '', text: '' + parts.join(' · ') };
}

// Rows that just turned failed — failing NOW and not already failing last poll.
// A key with no prior state is a first sighting, not a transition, so it stays
// quiet: adding an already-red workflow shouldn't fire a notification.
function diffNewFailures(rows, prevStates) {
  const prev = prevStates || {};
  return (rows || []).filter(r => r.state === 'failure' && prev[r.key] !== undefined && prev[r.key] !== 'failure');
}

// Poll fast while something is in flight, lazily otherwise. This is the whole
// "real time" story — no webhooks, no server.
function nextPollDelay(rows, intervalSec) {
  if ((rows || []).some(r => r.state === 'running')) return 10000;
  return Math.max(30, Number(intervalSec) || 60) * 1000;
}

// Runs grouped by repo for the dropdown, first-seen order kept on both levels.
function groupRunsByRepo(runs) {
  const by = new Map();
  for (const r of runs) { if (!by.has(r.repo)) by.set(r.repo, []); by.get(r.repo).push(r); }
  return [...by].map(([repo, list]) => ({ repo, runs: list }));
}

// Plan for the "Fix" button on a failed run: which local checkout to branch from,
// the fix branch off the failed branch, and the agent's opening prompt. The agent
// pulls the log itself with gh — pasting a big log into the terminal is fragile.
// Main checkouts beat worktrees (those belong to other work). No checkout → error.
function fixRunPlan(run, infos, worktreeDirs) {
  const id = ((run && run.url) || '').match(/\/actions\/runs\/(\d+)/);
  if (!id) return { error: 'No run to fix' };
  // head_branch can come from a fork's PR and worktree.js runs git through a shell on Windows
  if (!/^[\w./-]+$/.test(run.branch || '')) return { error: `Can't fix a run on branch "${run.branch}"` };
  const wts = new Set(worktreeDirs || []);
  const mine = (infos || []).filter(i => i.repo.toLowerCase() === run.repo.toLowerCase());
  const pick = mine.find(i => !wts.has(i.dir)) || mine[0];
  if (!pick) return { error: `No local checkout of ${run.repo} — open an agent in it once` };
  const prompt = `GitHub Actions run ${run.name} #${run.runNumber} failed on branch ${run.branch}: ${run.url} `
    + `- run: gh run view ${id[1]} --repo ${run.repo} --log-failed - to read the failing steps, `
    + `find the root cause, fix it on this branch (based on ${run.branch}), and verify the fix locally before committing.`;
  return {
    repoDir: pick.dir,
    branch: `fix/ci-${run.runNumber || id[1]}`,
    base: run.branch,
    // The exact commit CI ran — one fetch of a sha, no stale local branch.
    // Not for a PR run: that sha may be a fork's code, and the worktree inherits the
    // repo's folder trust. A fork branch isn't on origin, so its fetch just fails.
    startPoint: /^[0-9a-f]{40}$/.test(run.sha || '') && !/^pull_request/.test(run.event || '')
      ? run.sha : `origin/${run.branch}`,
    // Passed on the claude command line so it submits at boot. That line goes through
    // cmd.exe / sh -c, so only characters no shell treats specially survive.
    prompt: prompt.replace(/[^\w\s.,:/#@()'=+-]/g, '').replace(/\s+/g, ' '),
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { parseWorkflowInput, runState, actionsRollup, nextPollDelay, diffNewFailures, groupRunsByRepo, fixRunPlan, REPO_RE };
}
