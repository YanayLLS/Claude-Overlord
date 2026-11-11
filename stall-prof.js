// Temporary diagnostic: what the main process runs when it stalls. A low-rate CPU profile (2 ms samples) runs in 20 s
// windows; a window with a stall over 300 ms logs its top self-time functions to overlord.log, then a new window starts.
// ponytail: remove once the main-process stalls are found (2026-11-10).
const inspector = require('inspector');

function startStallProfiler(flog) {
  const s = new inspector.Session(); s.connect();
  const post = (m, p) => new Promise((res) => s.post(m, p || {}, (e, r) => res(e ? null : r)));
  let worst = 0, t = Date.now();
  setInterval(() => { const lag = Date.now() - t - 100; t = Date.now(); if (lag > worst) worst = lag; }, 100).unref();
  const window = async () => {
    worst = 0;
    await post('Profiler.start');
    setTimeout(async () => {
      const r = await post('Profiler.stop');
      if (r && worst > 300) {
        const p = r.profile, byId = new Map(p.nodes.map(n => [n.id, n])), self = new Map(), parent = new Map();
        for (const n of p.nodes) for (const c of (n.children || [])) parent.set(c, n.id);
        // A native call (existsSync, open, readFileUtf8…) is named with the JS function that made it.
        const jsCaller = (id) => { let q = parent.get(id), d = 0; while (q && d++ < 6) { const f = byId.get(q).callFrame; if (f.url && !/^node:/.test(f.url)) return `${f.functionName || '(anon)'}@${String(f.url).split(/[\/]/).pop()}:${f.lineNumber + 1}`; q = parent.get(q); } return ''; };
        p.samples.forEach((id, i) => { const f0 = byId.get(id).callFrame, f = f0.url ? f0 : { ...f0, functionName: f0.functionName + (jsCaller(id) ? ' < ' + jsCaller(id) : '') }; if (!f.functionName && !f.url) return; const k = `${f.functionName || '(anon)'} ${String(f.url).split(/[\\/]/).pop()}:${f.lineNumber + 1}`; self.set(k, (self.get(k) || 0) + (p.timeDeltas[i] || 0)); });
        const top = [...self].filter(([k]) => !/\(idle\)|\(program\)|\(garbage/.test(k)).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => `${Math.round(v / 1000)}ms ${k}`).join(' | ');
        flog(`main stall profile (worst ${worst}ms in 20s): ${top}`);
      }
      window();
    }, 20000).unref();
  };
  post('Profiler.enable').then(() => post('Profiler.setSamplingInterval', { interval: 2000 })).then(window);
}
module.exports = { startStallProfiler };
