// Pure helpers for the in-app git update (source checkouts run via start.bat).
// No electron, no child_process — just decisions. Self-check: update-core.test.js

// Tracked-file changes block a pull; untracked files don't (node_modules, logs,
// scratch files are none of our business). Porcelain marks untracked with '??'.
function hasTrackedChanges(porcelain) {
  return String(porcelain || '').split('\n')
    .map(l => l.trimEnd())
    .filter(Boolean)
    .some(l => !l.startsWith('??'));
}

// Why a pull must not proceed, or null when it's safe. Refusing is always the
// right call here: this runs unattended on a repo the user may be working in,
// and no update is worth eating someone's uncommitted work.
function pullBlocker({ porcelain, ahead }) {
  if (hasTrackedChanges(porcelain)) {
    return 'You have uncommitted changes. Commit or stash them, then update.';
  }
  if (Number(ahead) > 0) {
    return `Your branch has ${ahead} unpushed commit${ahead === 1 ? '' : 's'}. Push or reset before updating.`;
  }
  return null;
}

// A dependency change means node_modules is stale — reinstall before relaunching.
function needsInstall(changedFiles) {
  return (changedFiles || []).some(f => /(^|\/)(package\.json|package-lock\.json)$/.test(f.trim()));
}

// The update's own `npm install` rewrites these (lock re-synced to the new
// version, deps re-sorted), which used to block every next update as
// "uncommitted changes". The lock is pure npm output; package.json only counts
// as npm's when it parses to the same thing as HEAD, so a real edit still blocks.
function npmRewriteOnly(file, headText, workText) {
  if (file === 'package-lock.json') return true;
  if (file !== 'package.json') return false;
  const canon = (v) => Array.isArray(v) ? v.map(canon)
    : v && typeof v === 'object' ? Object.keys(v).sort().reduce((o, k) => (o[k] = canon(v[k]), o), {}) : v;
  try { return JSON.stringify(canon(JSON.parse(headText))) === JSON.stringify(canon(JSON.parse(workText))); }
  catch { return false; }
}

// Button label. Null means show nothing at all.
function updateLabel(behind) {
  const n = Number(behind) || 0;
  if (n <= 0) return null;
  return `⬇ Update (${n} commit${n === 1 ? '' : 's'})`;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { hasTrackedChanges, pullBlocker, needsInstall, updateLabel, npmRewriteOnly };
}
