// Filtering for the catalog popover (catalog-core.js builds the list) and the
// "//" trigger that opens it from the terminal. Pure, so it runs in tests and the page.

// Subsequence match; consecutive letters and word starts score higher. null = no match.
function fuzzyScore(q, s) {
  if (!q) return { score: 0, pos: [] };
  q = q.toLowerCase(); const t = s.toLowerCase();
  const pos = []; let score = 0, j = 0, prev = -2;
  for (let i = 0; i < t.length && j < q.length; i++) {
    if (t[i] !== q[j]) continue;
    score += 1 + (i === prev + 1 ? 5 : 0) + (i === 0 || /[\s\-_:/.]/.test(t[i - 1]) ? 3 : 0);
    pos.push(i); prev = i; j++;
  }
  if (j < q.length) return null;
  return { score: score - (t.length - q.length) * 0.01, pos }; // shorter names win ties
}

const ORIGIN_RANK = { repo: 0, pc: 1, plugin: 2, builtin: 3 };

// type null = every type. Empty query keeps origin order; otherwise best match first.
// A name match always beats a description-only match.
function pickItems(items, type, q) {
  const out = [];
  for (const it of items) {
    if (type && it.type !== type) continue;
    const n = fuzzyScore(q, it.name);
    const d = n ? null : (q && it.desc ? fuzzyScore(q, it.desc) : null);
    if (!n && !d) continue;
    out.push({ ...it, score: n ? n.score + 1000 : d.score, pos: n ? n.pos : [] });
  }
  return out.sort((a, b) => (q ? b.score - a.score : 0) || ORIGIN_RANK[a.origin] - ORIGIN_RANK[b.origin]);
}

// Wraps terminal input: a typed "/" is held `ms`; a second "/" in that window opens
// the popover and neither reaches the pty. Any other data flushes the held "/" first.
function makeSlashGate({ send, open, ms = 250, timer = { set: setTimeout, clear: clearTimeout } }) {
  let held = null;
  const flush = () => { if (held) { timer.clear(held); held = null; send('/'); } };
  return (data) => {
    if (data !== '/') { flush(); send(data); return; }
    if (held) { timer.clear(held); held = null; open(); return; }
    held = timer.set(() => { held = null; send('/'); }, ms);
  };
}

if (typeof module !== 'undefined' && module.exports) module.exports = { fuzzyScore, pickItems, makeSlashGate };
