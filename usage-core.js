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

// The OAuth usage endpoint (what Claude Code's /usage screen reads) returns every bucket
// in one JSON: five_hour / seven_day with utilization already in percent and an ISO
// resets_at, plus a "limits" list whose weekly_scoped entries carry a per-model cap
// (scope.model.display_name, e.g. "Fable"). Returns the same shape the header probe
// produces, or null when the JSON has neither of the two main buckets.
function parseOauthUsage(json) {
  const j = json || {};
  const iso = s => { const t = Date.parse(s || ''); return isNaN(t) ? 0 : t; };
  const pct = v => (v == null || isNaN(+v)) ? null : +(+v).toFixed(1);
  const usage = {};
  const h5 = j.five_hour && pct(j.five_hour.utilization), d7 = j.seven_day && pct(j.seven_day.utilization);
  if (h5 != null) { usage.hourly = h5; const r = iso(j.five_hour.resets_at); if (r) usage.hourlyReset = r; }
  if (d7 != null) { usage.weekly = d7; const r = iso(j.seven_day.resets_at); if (r) usage.weeklyReset = r; }
  const modelWeekly = [];
  for (const l of Array.isArray(j.limits) ? j.limits : []) {
    if (!l || l.kind !== 'weekly_scoped') continue;
    const name = l.scope && l.scope.model && (l.scope.model.display_name || l.scope.model.id);
    const p = pct(l.percent); if (!name || p == null) continue;
    modelWeekly.push({ model: String(name).toLowerCase(), pct: p, reset: iso(l.resets_at) });
  }
  if (modelWeekly.length) usage.modelWeekly = modelWeekly.sort((a, b) => a.model.localeCompare(b.model));
  return (usage.hourly != null || usage.weekly != null) ? usage : null;
}

// "fable" -> "Fable" for the row label. Model ids are lowercase in headers.
function modelLabel(model) {
  const s = String(model || '');
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : '';
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { parseModelWeekly, parseOauthUsage, modelLabel, MODEL_7D_RE };
}
