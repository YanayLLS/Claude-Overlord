// The shell agent terminals run under — always an absolute path on Windows.
// Self-check: shell-core.test.js
//
// Why not plain 'cmd.exe': node-pty resolves a relative file itself, and its
// resolver (get_shell_path) bails out with an EMPTY path when a file of that
// name also sits in the *spawning process's* working directory. Every spawn
// then dies with a blank `File not found: `. The NSIS updater relaunches
// Overlord from C:\Windows\System32 — which of course holds cmd.exe — and
// pty-host.js inherits that cwd, so a single update left every agent, old and
// new, unable to start a terminal. An absolute path skips the resolver.
const ABS_WIN = /^[a-z]:[\\/]/i;

function agentShell(platform = process.platform, env = process.env) {
  if (platform !== 'win32') return env.SHELL || 'bash';
  const comspec = env.ComSpec || env.COMSPEC;
  if (comspec && ABS_WIN.test(comspec)) return comspec;
  return `${env.SystemRoot || env.windir || 'C:\\Windows'}\\System32\\cmd.exe`;
}

module.exports = { agentShell };
