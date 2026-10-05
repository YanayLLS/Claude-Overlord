// First-run setup: which of the tools Overlord needs are missing on this machine.
// Self-check: setup-core.test.js
//
// Agents are `claude` sessions in git repos, so a fresh PC without either has
// nothing to run. Detection is a plain file probe — no spawn — because a GUI-
// launched app holds the PATH explorer.exe had at login: a tool installed since
// then is on disk but not on our PATH, and the caller prepends the dir we return.
const path = require('path').win32;

// Order matters: Claude Code on Windows needs Git Bash, so git installs first.
const SETUP_TOOLS = [
  {
    id: 'git', label: 'Git', url: 'https://git-scm.com/download/win',
    names: ['git.exe'],
    dirs: env => [
      'C:\\Program Files\\Git\\cmd',
      env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs', 'Git', 'cmd'),
    ],
    cmd: 'winget install --id Git.Git -e --source winget --accept-package-agreements --accept-source-agreements',
  },
  {
    id: 'claude', label: 'Claude Code', url: 'https://claude.com/product/claude-code',
    names: ['claude.exe', 'claude.cmd'],
    dirs: env => [
      env.USERPROFILE && path.join(env.USERPROFILE, '.local', 'bin'), // native installer
      env.APPDATA && path.join(env.APPDATA, 'npm'), // npm i -g
    ],
    cmd: 'powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://claude.ai/install.ps1 | iex"',
  },
];

const safe = exists => f => { try { return exists(f); } catch { return false; } };

// 'path' when already reachable, the dir to prepend when only on disk, else null.
function findTool(tool, env, exists) {
  const ok = safe(exists);
  const hit = dir => dir && tool.names.some(n => ok(path.join(dir, n)));
  if ((env.PATH || env.Path || '').split(';').some(hit)) return 'path';
  return tool.dirs(env).find(hit) || null;
}

function missingTools(env, exists) {
  return SETUP_TOOLS.filter(t => !findTool(t, env, exists)).map(t => t.id);
}

// The installer's latest step for the card. Piped, winget prints plain step lines
// (no progress bar) and install.ps1 silences its own, so the step text is all there is.
function progressLine(out) {
  const lines = String(out).replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').split(/[\r\n]+/)
    .map(l => l.trim()).filter(l => l.length > 1); // drops blanks and spinner frames
  const last = lines.length ? lines[lines.length - 1] : '';
  return last.replace(/https?:\/\/\S*\/([^\s/]+)/g, '$1').slice(0, 90);
}

module.exports = { SETUP_TOOLS, findTool, missingTools, progressLine };
