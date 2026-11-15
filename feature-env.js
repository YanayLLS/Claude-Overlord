// A feature's dev servers find each other: a front-end worktree in a feature talks to the same
// feature's backend worktree instead of the shared/deployed one. Pure: main.js supplies which
// servers run and which env vars a repo's scripts read, and spawns with the result.
const path = require('path');

// env var a repo's dev scripts read -> the repo whose server URL it takes. Wired only when that
// repo is in the same feature, its server is running, and the user hasn't set the var already.
const LINKS = [{ name: 'FL_BACK_URL', repo: 'frontline.io-web' }]; // Designs' dev-local.mjs: "FL_BACK_URL=<url> overrides" the backend

const base = (p) => path.basename(String(p).replace(/\\/g, '/'));
const slugVar = (s) => s.toUpperCase().replace(/[^A-Z0-9]+/g, '_');

// entry: the worktree starting. running(path) -> its server URL or null. reads(repo, name) -> bool.
// Returns { env, links } — links for the log line and toast.
function featureEnv({ entry, worktrees, running, reads, base: baseEnv = {} }) {
  const env = {}, links = [];
  if (!entry || !entry.feature) return { env, links };
  const siblings = (worktrees || []).filter(w => w.feature === entry.feature && w.path !== entry.path);
  for (const s of siblings) {
    const url = running(s.path);
    if (!url) continue;
    env[`OVERLORD_FEATURE_${slugVar(base(s.repo))}_URL`] = url; // any script can pick its siblings up from here
    for (const l of LINKS) {
      if (base(s.repo) !== l.repo || baseEnv[l.name] || env[l.name] || !reads(entry.repo, l.name)) continue;
      env[l.name] = url; links.push({ name: l.name, repo: l.repo, url });
    }
  }
  return { env, links };
}

// Backends other repos link to start first, so the front-ends that start after them get wired.
function startOrder(members) {
  const isTarget = (w) => LINKS.some(l => l.repo === base(w.repo));
  return [...members].sort((a, b) => isTarget(b) - isTarget(a));
}

module.exports = { featureEnv, startOrder, LINKS };
