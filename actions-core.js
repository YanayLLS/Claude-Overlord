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
  if (errs) return { cls: 'err', text: `⚙ Actions — ${errs} check failed` };
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
  if (running) return { cls: 'running', text: '⚙ ' + parts.join(' · ') };
  if (failed) return { cls: myFailure ? 'alert' : 'warn', text: '⚙ ' + parts.join(' · ') };
  if (ok && !never) return { cls: '', text: `⚙ All ${ok} up to date` };
  return { cls: '', text: '⚙ ' + parts.join(' · ') };
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

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { parseWorkflowInput, runState, actionsRollup, nextPollDelay, diffNewFailures, REPO_RE };
}
