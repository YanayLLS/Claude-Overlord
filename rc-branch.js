// The release-candidate branch: when the card holds, Fix blockers freezes the tested commits on `rc/<run>` in every
// repo the regression can be pointed at, the fixes go there (not to dev, which keeps moving), a quick re-run checks
// them, and the release ships that branch. Afterwards (or when a newer run supersedes it) the branch merges back
// into dev and is deleted. Pure: names, which modules to re-run, how the re-run is read, what to do with a branch.

// repo name → the bdd-regression input that points the run at it
const RC_INPUTS = { 'frontlineio-frontend': 'frontend_ref', 'frontline.io-web': 'backend_ref', 'auth-server': 'auth_ref', 'identity-server': 'identity_ref' };
const rcName = (runId) => `rc/${runId}`;
const short = (repo) => String(repo).split('/').pop();

// Which repos get an rc branch: the ones the regression tested that it can be pointed at. shas: card's c.shas.
function rcRepos(shas) {
  const out = {};
  for (const [repo, v] of Object.entries(shas || {})) if (v && v.tested && v.sha && RC_INPUTS[short(repo)]) out[repo] = { tested: v.sha, target: v.target || 'master' };
  return out;
}

// The re-run: failed (and unreported) modules only when every merged fix touched tests alone, since a test change
// can't break another module; any product change re-runs everything. null = full. On-prem modules ship separately.
const testOnly = (files, frontend = 'frontlineio-frontend') => (files || []).every(f => short(f.repo) === frontend && f.path.startsWith('tests/'));
function failedModules(page, offRelease = '^onprem') {
  if (!page) return [];
  const off = new RegExp(offRelease, 'i');
  const mods = [...page.failures.filter(f => !f.flaky).map(f => f.module), ...page.modules.filter(m => !m.report).map(m => m.name)];
  return [...new Set(mods)].filter(m => !off.test(m));
}
const rerunScopes = ({ page, files, frontend, offRelease }) => testOnly(files, frontend) && page ? failedModules(page, offRelease) : null;

// The candidate after a partial re-run: the graded run with the re-run modules' results swapped in. A module the
// re-run didn't report reads as not reported.
function overlay(page, rerun, modules) {
  const re = new Set(modules);
  return { ...page,
    modules: page.modules.map(m => !re.has(m.name) ? m : (rerun.modules.find(x => x.name === m.name) || { ...m, report: null })),
    failures: page.failures.filter(f => !re.has(f.module)).concat(rerun.failures.filter(f => re.has(f.module))) };
}

// A branch being retired: ahead = commits it has beyond the tested one; pr = its merge-back PR into dev, if any.
function retireAction({ ahead, pr }) {
  if (ahead === 0) return 'delete';
  if (!pr) return 'open';
  return pr.merged || pr.state === 'closed' ? 'delete' : 'wait';
}

// The rc is still the candidate while the graded run is its own (the run it was cut from, or a run of the branch).
const supersededBy = (rc, graded) => !!rc && !!graded && graded.nightlyId !== rc.runId && graded.ref !== rc.name;

module.exports = { RC_INPUTS, rcName, rcRepos, testOnly, failedModules, rerunScopes, overlay, retireAction, supersededBy };
