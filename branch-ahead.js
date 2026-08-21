// Commits sitting on your local branches that a tracked workflow's branch does
// not have yet — the "you forgot to open a PR" counter on each Actions row.
// Local git rather than the compare API: unpushed commits count too, and the
// repos are already on disk because you're working in them.
const { execFile } = require('child_process');

const GIT_OPTS = { windowsHide: true, maxBuffer: 8 * 1024 * 1024 };

// Never rejects: a non-repo, a missing ref and a git that isn't installed are all
// just "unknown" here, and none of them should take down an actions poll.
function git(dir, args, timeout = 15000) {
  return new Promise((resolve) => {
    execFile('git', ['-C', dir, ...args], { ...GIT_OPTS, timeout },
      (err, stdout) => resolve(err ? null : String(stdout).trim()));
  });
}

// git@github.com:LLSLtd/x.git | https://github.com/LLSLtd/x.git | ssh://…/x → LLSLtd/x
function remoteRepo(url) {
  const m = String(url || '').trim().match(/github\.com[:/]+([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i);
  return m ? `${m[1]}/${m[2]}` : '';
}

// What repo and branch a directory is sitting on. null when it isn't a GitHub
// checkout, or is detached — a detached HEAD has no branch to open a PR from.
async function checkoutInfo(dir) {
  const [url, branch] = await Promise.all([
    git(dir, ['remote', 'get-url', 'origin'], 10000),
    git(dir, ['rev-parse', '--abbrev-ref', 'HEAD'], 10000),
  ]);
  const repo = remoteRepo(url);
  if (!repo || !branch || branch === 'HEAD') return null;
  return { dir, repo, branch };
}

const lastFetch = new Map();
const FETCH_EVERY_MS = 5 * 60 * 1000;

// origin/<base> is only as fresh as the last fetch, and a stale ref inflates the
// count with commits that already shipped. One base ref, at most every 5 minutes.
async function refreshBase(dir, base, now) {
  const k = dir + '\0' + base;
  if (now - (lastFetch.get(k) || 0) < FETCH_EVERY_MS) return;
  lastFetch.set(k, now);
  await git(dir, ['fetch', 'origin', base, '--quiet'], 30000);
}

// Commits on the checkout's HEAD that origin/<base> doesn't have. null = unknown
// (no such remote branch, fetch failed) so the row can show nothing, not "0".
async function aheadOf(dir, base, now = Date.now()) {
  await refreshBase(dir, base, now);
  const out = await git(dir, ['rev-list', '--count', `origin/${base}..HEAD`], 20000);
  const n = parseInt(out, 10);
  return Number.isFinite(n) ? n : null;
}

// One row's badge. The branch furthest ahead owns the number; the rest are only
// in the tooltip. Nothing ahead → no badge, so a quiet row stays quiet.
function aheadSummary(entries, base) {
  const list = (entries || []).filter(e => e && e.count > 0).sort((a, b) => b.count - a.count);
  if (!list.length) return null;
  const title = list.map(e => `${e.count} commit${e.count === 1 ? '' : 's'} on ${e.branch} not in ${base}`).join('\n');
  return { count: list[0].count, title };
}

module.exports = { remoteRepo, checkoutInfo, aheadOf, aheadSummary };
