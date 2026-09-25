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

// The header fallback only sees the probed model's buckets, so a fetch that took it drops the
// per-model caps it can't see. Keep the last known ones until their reset passes.
function carryModelWeekly(next, prev, now) {
  if (!next || (next.modelWeekly && next.modelWeekly.length)) return next;
  const kept = ((prev && prev.modelWeekly) || []).filter(m => !m.reset || m.reset > now);
  if (kept.length) next.modelWeekly = kept;
  return next;
}

// ── Usage history: every meter's % per sample, one sample per 10 min, 8 days kept ──
const USAGE_SAMPLE_MS = 10 * 60000;
const USAGE_KEEP_MS = 8 * 86400000;
// Meter keys: 'h' session, 'w' week, 'm:<model>' a per-model weekly cap.
function usageSample(usage, now) {
  const p = { t: now };
  if (usage.hourly != null) p.h = usage.hourly;
  if (usage.weekly != null) p.w = usage.weekly;
  for (const m of usage.modelWeekly || []) p['m:' + m.model] = m.pct;
  return p;
}
// The newest sample always carries the latest reading; older ones stay >= 10 min apart.
function appendUsageSample(hist, usage, now) {
  if (!usage || (usage.hourly == null && usage.weekly == null)) return hist;
  const pts = (hist || []).filter(p => p.t > now - USAGE_KEEP_MS);
  const point = usageSample(usage, now);
  if (pts.length >= 2 && now - pts[pts.length - 2].t < USAGE_SAMPLE_MS) pts[pts.length - 1] = point;
  else pts.push(point);
  return pts;
}

// The meters a usage reading has, each with its reset window, so any of them can be charted.
const H5 = 5 * 3600000, D7 = 7 * 86400000;
function usageMeters(usage) {
  if (!usage) return [];
  const out = [];
  if (usage.hourly != null) out.push({ key: 'h', label: 'Session', pct: usage.hourly, reset: usage.hourlyReset || 0, span: H5 });
  if (usage.weekly != null) out.push({ key: 'w', label: 'Week', pct: usage.weekly, reset: usage.weeklyReset || 0, span: D7 });
  for (const m of usage.modelWeekly || []) out.push({ key: 'm:' + m.model, label: modelLabel(m.model), pct: m.pct, reset: m.reset || usage.weeklyReset || 0, span: D7 });
  return out;
}

// SVG of one meter's % across its window [start, end]: line + area, a dashed "on pace"
// diagonal, time ticks (hours for a session, weekdays for a week), a dot on the latest reading.
function usageChartSvg(points, key, start, end, W = 280, H = 110) {
  const L = 30, R = 8, T = 8, B = 18, pw = W - L - R, ph = H - T - B;
  const x = t => L + ((t - start) / (end - start)) * pw;
  const y = v => T + ph - (Math.min(v, 100) / 100) * ph;
  const f = n => n.toFixed(1);
  let s = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Usage over this window">`;
  for (const v of [0, 50, 100]) {
    s += `<line x1="${L}" x2="${L + pw}" y1="${f(y(v))}" y2="${f(y(v))}" class="uc-grid"/>`
      + `<text x="${L - 5}" y="${f(y(v) + 3)}" text-anchor="end" class="uc-axis">${v}%</text>`;
  }
  if (end - start > 86400000) {
    const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    for (let t = start; t < end; t += 86400000) {
      s += `<text x="${f(x(t + 43200000))}" y="${H - 5}" text-anchor="middle" class="uc-axis">${DAYS[new Date(t + 43200000).getDay()]}</text>`;
    }
  } else {
    for (let t = Math.ceil(start / 3600000) * 3600000; t < end; t += 3600000) {
      s += `<text x="${f(x(t))}" y="${H - 5}" text-anchor="middle" class="uc-axis">${String(new Date(t).getHours()).padStart(2, '0')}:00</text>`;
    }
  }
  s += `<line x1="${f(x(start))}" y1="${f(y(0))}" x2="${f(x(end))}" y2="${f(y(100))}" class="uc-pace"/>`;
  const pts = (points || []).filter(p => p.t >= start && p.t <= end && p[key] != null);
  if (pts.length) {
    const line = pts.map(p => `${f(x(p.t))},${f(y(p[key]))}`).join(' L');
    s += `<path d="M${f(x(pts[0].t))},${f(y(0))} L${line} L${f(x(pts[pts.length - 1].t))},${f(y(0))} Z" class="uc-area"/>`;
    s += `<path d="M${line}" class="uc-line"/>`;
    const last = pts[pts.length - 1];
    s += `<circle cx="${f(x(last.t))}" cy="${f(y(last[key]))}" r="4" class="uc-dot"/>`;
  }
  return s + '</svg>';
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { parseModelWeekly, parseOauthUsage, modelLabel, carryModelWeekly, appendUsageSample, usageMeters, usageChartSvg, MODEL_7D_RE };
}
