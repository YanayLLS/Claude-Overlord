// Run: node perf-core.test.js
const assert = require('assert');
const { parseProcLines, agentUsage } = require('./perf-core');

// pid|ppid|workingSet|cpu100ns|created|name|cmdline — cmdline last, may hold '|'
const text = [
  '10|1|1000|0|100|cmd.exe|cmd /c claude',
  '11|10|300000000|50000000|101|node.exe|node claude.js --session-id x',
  '12|11|200000000|20000000|102|chrome.exe|chrome --a|b',
  '13|11|100000000|10000000|103|chrome.exe|chrome --renderer',
  '14|10|5000|0|90|conhost.exe|stale pid reuse: born before its "parent"',
  '20|1|1000|0|100|cmd.exe|cmd /c claude',
  '21|20|50000000|0|101|node.exe|node claude.js',
  '99|1|900000000|0|1|Code.exe|not an agent',
  'garbage line',
].join('\r\n');

const procs = parseProcLines(text);
assert.strictEqual(procs.length, 8);
assert.deepStrictEqual(procs[2], { pid: 12, ppid: 11, mem: 200000000, cpu: 20000000, created: 102, name: 'chrome.exe', cmd: 'chrome --a|b' });

const roots = [{ id: 1, pid: 10 }, { id: 2, pid: 20 }, { id: 3, pid: 777 }];
// first sample: no CPU baseline yet
let u = agentUsage(procs, roots, null, 0, 4);
assert.deepStrictEqual(u.rows.map(r => r.id), [1, 2]); // heaviest first; a dead root drops out
const a1 = u.rows[0];
assert.strictEqual(a1.mem, 1000 + 300000000 + 200000000 + 100000000); // the stale pid-reuse child is excluded
assert.strictEqual(a1.procs, 4);
assert.strictEqual(a1.cpu, null);
// same-name children group, heaviest group first; the root shell itself isn't listed
assert.deepStrictEqual(a1.top.map(t => [t.name, t.count, t.mem]), [['node.exe', 1, 300000000], ['chrome.exe', 2, 300000000]]);

// second sample 1s later: 11 used +1s CPU (1e7 × 100ns) on 4 cores = 25% of the machine
const base = u.cpuByPid;
const later = procs.map(p => p.pid === 11 ? { ...p, cpu: p.cpu + 1e7 } : p);
u = agentUsage(later, roots, base, 1000, 4);
assert.strictEqual(u.rows[0].cpu, 25);
assert.strictEqual(u.rows[0].top[0].cpu, 25);
assert.strictEqual(u.rows[1].cpu, 0);
// a process that appears between samples counts from zero, not from its lifetime total
const born = [...later, { pid: 15, ppid: 11, mem: 1, cpu: 4e7, created: 104, name: 'x.exe', cmd: '' }];
assert.strictEqual(agentUsage(born, roots, base, 1000, 4).rows[0].cpu, 25);

console.log('ok — perf-core checks passed');
