// Pure helpers for parsing Anthropic rate-limit headers. Self-check: usage-core.test.js

// Per-model weekly limits arrive as anthropic-ratelimit-unified-7d-<model>-utilization.
// Matched by shape rather than by a hardcoded model name: the model tiers change
// (opus → fable → whatever is next) and a hardcoded name silently shows nothing
// the day it moves. Whatever the account actually has a weekly cap on shows up.
const MODEL_7D_RE = /^anthropic-ratelimit-unified-7d-([a-z0-9.-]+)-utilization$/i;

// Returns [{ model, pct, reset }] sorted by model, for whatever per-model weekly
// limits the headers report. reset is ms since epoch, or 0 when absent.
function parseModelWeekly(headers) {
  const h = headers || {};
  const out = [];
  for (const key of Object.keys(h)) {
    const m = key.toLowerCase().match(MODEL_7D_RE);
    if (!m) continue;
    const pct = parseFloat(h[key]);
    if (isNaN(pct)) continue;
    const resetRaw = h[`anthropic-ratelimit-unified-7d-${m[1]}-reset`];
    const resetSec = parseInt(resetRaw, 10);
    out.push({
      model: m[1],
      pct: +(pct * 100).toFixed(1),
      reset: isNaN(resetSec) ? 0 : resetSec * 1000,
    });
  }
  return out.sort((a, b) => a.model.localeCompare(b.model));
}

// "fable" -> "Fable" for the row label. Model ids are lowercase in headers.
function modelLabel(model) {
  const s = String(model || '');
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : '';
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { parseModelWeekly, modelLabel, MODEL_7D_RE };
}
