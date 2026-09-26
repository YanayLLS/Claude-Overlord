// Per-agent resource use for the header's performance popover: which agent's process
// tree (claude, its Bash children, test runners, browsers) is eating memory and CPU.
// Pure — main.js does the one process-table scan. Self-check: perf-core.test.js

// One line per process: pid|ppid|workingSet|cpu100ns|created|name|cmdline.
// cmdline is last because it can contain '|'.
function parseProcLines(text) {
  const out = [];
  for (const line of String(text || '').split(/[\r\n]+/)) {
    const f = line.split('|');
    if (f.length < 7) continue;
    const [pid, ppid, mem, cpu, created] = f.slice(0, 5).map(Number);
    if (!pid) continue;
    out.push({ pid, ppid, mem: mem || 0, cpu: cpu || 0, created: created || 0, name: f[5], cmd: f.slice(6).join('|') });
  }
  return out;
}

// roots: [{ id, pid }] — each agent's terminal shell. prevCpu: the last call's
// cpuByPid (null on the first sample → cpu is null). dtMs: time between samples.
// CPU is % of the whole machine, like Task Manager.
function agentUsage(procs, roots, prevCpu, dtMs, cores) {
  const byPid = new Map(procs.map(p => [p.pid, p]));
  const kids = new Map();
  for (const p of procs) {
    const parent = byPid.get(p.ppid);
    // Windows reuses pids: a child "born" before its parent belongs to a dead one.
    if (!parent || p.created < parent.created || p.pid === p.ppid) continue;
    if (!kids.has(p.ppid)) kids.set(p.ppid, []);
    kids.get(p.ppid).push(p);
  }
  const pct = (p) => {
    if (!prevCpu || !dtMs) return null;
    const was = prevCpu.get(p.pid);
    if (was === undefined) return 0; // new since last sample — no baseline
    return Math.max(0, (p.cpu - was) / (dtMs * 1e4) / (cores || 1) * 100);
  };
  const round = (n) => n === null ? null : Math.round(n * 10) / 10;
  const rows = [];
  for (const { id, pid } of roots) {
    const root = byPid.get(pid);
    if (!root) continue;
    const tree = [root];
    for (let i = 0; i < tree.length; i++) tree.push(...(kids.get(tree[i].pid) || []));
    const groups = new Map();
    let mem = 0, cpu = prevCpu ? 0 : null;
    for (const p of tree) {
      const c = pct(p);
      mem += p.mem;
      if (c !== null) cpu += c;
      if (p === root) continue;
      const g = groups.get(p.name) || { name: p.name, count: 0, mem: 0, cpu: c === null ? null : 0, cmd: '', heaviest: 0 };
      g.count++; g.mem += p.mem;
      if (c !== null) g.cpu += c;
      if (p.mem > g.heaviest) { g.heaviest = p.mem; g.cmd = p.cmd; }
      groups.set(p.name, g);
    }
    const top = [...groups.values()].sort((a, b) => b.mem - a.mem)
      .map(({ heaviest, ...g }) => ({ ...g, cpu: round(g.cpu) }));
    rows.push({ id, mem, cpu: round(cpu), procs: tree.length, top });
  }
  rows.sort((a, b) => b.mem - a.mem);
  return { rows, cpuByPid: new Map(procs.map(p => [p.pid, p.cpu])) };
}

module.exports = { parseProcLines, agentUsage };
