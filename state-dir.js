// One-time move of the state directory from its pre-rename name.
// Self-check: state-dir.test.js

const fs = require('fs');
const path = require('path');

// The files worth carrying across. Logs and per-worktree setup output regenerate,
// so they stay behind rather than doubling on disk.
const MIGRATE = ['overlord-state.json', 'overlord-state.json.bak', 'overlord-settings.json', 'accounts.json'];

// Copy, never move: if someone rolls back to an older build afterwards, the old
// directory is still there and still whole. Returns how many files were copied.
function migrateLegacy(legacyDir, stateDir) {
  if (!legacyDir || !stateDir || legacyDir === stateDir) return 0;
  try {
    if (!fs.existsSync(legacyDir)) return 0;
    if (fs.existsSync(path.join(stateDir, 'overlord-state.json'))) return 0; // already migrated
    fs.mkdirSync(stateDir, { recursive: true });
    let n = 0;
    for (const f of MIGRATE) {
      const from = path.join(legacyDir, f);
      const to = path.join(stateDir, f);
      if (!fs.existsSync(from) || fs.existsSync(to)) continue;
      fs.copyFileSync(from, to);
      n++;
    }
    return n;
  } catch { return 0; }
}

module.exports = { migrateLegacy, MIGRATE };
