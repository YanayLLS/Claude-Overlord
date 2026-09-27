// Self-check for shell-core. Run: node shell-core.test.js
const assert = require('assert');
const { agentShell } = require('./shell-core');

// Windows: the absolute ComSpec, never the bare 'cmd.exe' node-pty would have
// to resolve against the working directory.
assert.strictEqual(agentShell('win32', { ComSpec: 'C:\\WINDOWS\\system32\\cmd.exe' }), 'C:\\WINDOWS\\system32\\cmd.exe');

// Some shells hand down COMSPEC in upper case.
assert.strictEqual(agentShell('win32', { COMSPEC: 'D:\\Windows\\System32\\cmd.exe' }), 'D:\\Windows\\System32\\cmd.exe');

// A relative or missing ComSpec is exactly the case that broke — fall back to
// an absolute path built from SystemRoot rather than passing it through.
assert.strictEqual(agentShell('win32', { ComSpec: 'cmd.exe', SystemRoot: 'C:\\WINDOWS' }), 'C:\\WINDOWS\\System32\\cmd.exe');
assert.strictEqual(agentShell('win32', { windir: 'C:\\WINDOWS' }), 'C:\\WINDOWS\\System32\\cmd.exe');
assert.strictEqual(agentShell('win32', {}), 'C:\\Windows\\System32\\cmd.exe');

// Whatever the result, it is absolute — node-pty must never have to search.
for (const env of [{}, { ComSpec: 'cmd.exe' }, { ComSpec: 'C:/Windows/System32/cmd.exe' }]) {
  assert.match(agentShell('win32', env), /^[a-z]:[\\/]/i);
}

// POSIX keeps the login shell, and bash when there is none.
assert.strictEqual(agentShell('darwin', { SHELL: '/bin/zsh' }), '/bin/zsh');
assert.strictEqual(agentShell('linux', {}), 'bash');

console.log('shell-core ok');
