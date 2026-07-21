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

// Button label. Null means show nothing at all.
function updateLabel(behind) {
  const n = Number(behind) || 0;
  if (n <= 0) return null;
  return `⬇ Update (${n} commit${n === 1 ? '' : 's'})`;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { hasTrackedChanges, pullBlocker, needsInstall, updateLabel };
}
