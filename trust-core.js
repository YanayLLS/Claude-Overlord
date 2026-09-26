// Claude asks "do you trust this folder?" for every new directory, which stalls an
// agent Overlord started unattended. A worktree is the same repo as its checkout, so
// if you already trusted the checkout, the worktree inherits it. Pure: mutates the
// parsed ~/.claude.json object and says whether it changed. Self-check: trust-core.test.js

// ~/.claude.json keys projects by forward-slash path (C:/Work/x); cwd strings on
// Windows use backslashes and whatever case the user typed.
const norm = (p) => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '');

function findKey(projects, p) {
  const want = norm(p).toLowerCase();
  return Object.keys(projects).find(k => norm(k).toLowerCase() === want);
}

function inheritTrust(cfg, repoDir, dir) {
  const projects = cfg && cfg.projects;
  if (!projects) return false;
  const repoKey = findKey(projects, repoDir);
  if (!repoKey || projects[repoKey].hasTrustDialogAccepted !== true) return false;
  const key = findKey(projects, dir) || norm(dir);
  if (projects[key] && projects[key].hasTrustDialogAccepted === true) return false;
  projects[key] = { ...(projects[key] || {}), hasTrustDialogAccepted: true };
  return true;
}

module.exports = { inheritTrust };
