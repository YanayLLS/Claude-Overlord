const test = require('node:test');
const assert = require('node:assert');
const { guardedPids } = require('./kill-guard');

const P = (pid, ppid, name, created, cmd = '') => ({ pid, ppid, name, created, cmd });

test('guards the launch chain and each console host, stopping at explorer', () => {
  const procs = [
    P(1, 0, 'explorer.exe', 1),
    P(10, 1, 'cmd.exe', 10), P(11, 10, 'conhost.exe', 11),
    P(20, 10, 'node.exe', 20), P(30, 20, 'electron.exe', 30),
    P(31, 30, 'electron.exe', 31, 'electron.exe --type=renderer'),
  ];
  assert.deepStrictEqual(guardedPids(procs, 30).sort((a, b) => a - b), [10, 11, 20, 30]);
});

test('a reused PID born after its child is not treated as the parent', () => {
  const procs = [P(10, 1, 'cmd.exe', 99), P(30, 10, 'electron.exe', 30)];
  assert.deepStrictEqual(guardedPids(procs, 30), [30]);
});

test('stops at a launcher it does not own, like a terminal app', () => {
  const procs = [P(5, 1, 'WindowsTerminal.exe', 5), P(10, 5, 'cmd.exe', 10), P(30, 10, 'electron.exe', 30)];
  assert.deepStrictEqual(guardedPids(procs, 30).sort((a, b) => a - b), [10, 30]);
});

test('guards the pty host, which outlives the app that launched it', () => {
  const procs = [P(30, 1, 'electron.exe', 30), P(40, 999, 'electron.exe', 40, 'electron.exe C:\\Work\\overlord\\pty-host.js \\\\.\\pipe\\overlord-pty-x')];
  assert.ok(guardedPids(procs, 30).includes(40));
});
