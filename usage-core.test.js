// Run: node usage-core.test.js
const assert = require('assert');
const { parseModelWeekly, parseOauthUsage, modelLabel, carryModelWeekly } = require('./usage-core');

// ── carryModelWeekly: a header-probe fetch keeps the last known per-model caps until they reset
{
  const prev = { modelWeekly: [{ model: 'fable', pct: 6, reset: 2000 }, { model: 'opus', pct: 1, reset: 500 }] };
  assert.deepStrictEqual(carryModelWeekly({ weekly: 33 }, prev, 1000).modelWeekly, [{ model: 'fable', pct: 6, reset: 2000 }]);
  const fresh = { weekly: 33, modelWeekly: [{ model: 'fable', pct: 7, reset: 2000 }] };
  assert.strictEqual(carryModelWeekly(fresh, prev, 1000).modelWeekly[0].pct, 7); // fresh data wins
  assert.strictEqual(carryModelWeekly({ weekly: 1 }, null, 1000).modelWeekly, undefined);
}

// ── appendUsageSample: every meter, >= 10 min spacing, newest always latest, 8-day window
{
  const { appendUsageSample, usageMeters, usageChartSvg } = require('./usage-core');
  const M = 60000;
  let h = appendUsageSample([], { weekly: 10, hourly: 5, modelWeekly: [{ model: 'fable', pct: 6 }] }, 0);
  assert.deepStrictEqual(h[0], { t: 0, h: 5, w: 10, 'm:fable': 6 });
  // resets ride along, so past windows can be cut where the API reset them
  assert.strictEqual(appendUsageSample([], { hourly: 1, hourlyReset: 5000 }, 0)[0]['h@'], 5000);
  h = appendUsageSample(h, { weekly: 11 }, 1 * M);        // second point always appended
  h = appendUsageSample(h, { weekly: 12 }, 2 * M);        // < 10 min after the 1st -> replaces the newest
  assert.deepStrictEqual(h.map(p => p.w), [10, 12]);
  h = appendUsageSample(h, { weekly: 13 }, 11 * M);       // >= 10 min after the 1st -> kept
  assert.deepStrictEqual(h.map(p => p.w), [10, 12, 13]);
  assert.strictEqual(appendUsageSample(h, {}, 12 * M), h); // nothing to record -> unchanged
  assert.deepStrictEqual(appendUsageSample(h, { weekly: 1 }, 61 * 86400000).map(p => p.w), [1]); // old ones pruned
  assert.deepStrictEqual(usageMeters({ hourly: 1, weekly: 2, modelWeekly: [{ model: 'fable', pct: 3 }] }).map(m => m.key), ['h', 'w', 'm:fable']);
  const svg = usageChartSvg([{ t: 1000, w: 20 }, { t: 2000, w: 40 }], 'w', 0, 7 * 86400000);
  assert.ok(svg.startsWith('<svg') && svg.includes('uc-line') && svg.includes('Mon') || svg.includes('Thu'));
  assert.ok(usageChartSvg([{ t: 1000, h: 5 }], 'h', 0, 5 * 3600000).includes(':00'));
  assert.ok(!usageChartSvg([{ t: 1000, h: 5 }], 'w', 0, 1).includes('uc-line')); // no data for that meter
}

// ── usageWindows: one window per reset seen, final reading each, current one last
{
  const { usageWindows } = require('./usage-core');
  const H = 3600000, S = 5 * H;
  const pts = [
    { t: 1 * H, h: 10, 'h@': 5 * H }, { t: 4 * H, h: 40, 'h@': 5 * H },   // session ending at 5h
    { t: 9 * H, h: 20, 'h@': 12 * H },                                    // session ending at 12h
  ];
  const ws = usageWindows(pts, 'h', S, 20 * H, 13 * H);                   // current one ends at 20h, no data yet
  assert.deepStrictEqual(ws.map(w => [w.end / H, w.last]), [[5, 40], [12, 20], [20, null]]);
  assert.strictEqual(usageWindows([], 'w', 7 * 86400000, 0, 1000).length, 1); // no history: just "now"
}

// ── parseModelWeekly ──────────────────────────────────
assert.deepStrictEqual(parseModelWeekly({}), []);
assert.deepStrictEqual(parseModelWeekly(null), []);

// the whole point: a per-model weekly cap is found without naming the model
assert.deepStrictEqual(
  parseModelWeekly({ 'anthropic-ratelimit-unified-7d-fable-utilization': '0.42' }),
  [{ model: 'fable', pct: 42, reset: 0 }]);
assert.deepStrictEqual(
  parseModelWeekly({ 'anthropic-ratelimit-unified-7d-opus-utilization': '0.075' }),
  [{ model: 'opus', pct: 7.5, reset: 0 }]);

// reset pairs up with its own model, and converts s -> ms
assert.deepStrictEqual(
  parseModelWeekly({
    'anthropic-ratelimit-unified-7d-fable-utilization': '0.5',
    'anthropic-ratelimit-unified-7d-fable-reset': '1700000000',
  }),
  [{ model: 'fable', pct: 50, reset: 1700000000000 }]);

// several models come back sorted, each with its own reset
assert.deepStrictEqual(
  parseModelWeekly({
    'anthropic-ratelimit-unified-7d-opus-utilization': '0.2',
    'anthropic-ratelimit-unified-7d-fable-utilization': '0.1',
    'anthropic-ratelimit-unified-7d-opus-reset': '1700000000',
  }),
  [
    { model: 'fable', pct: 10, reset: 0 },
    { model: 'opus', pct: 20, reset: 1700000000000 },
  ]);

// the account-wide weekly header must NOT be mistaken for a per-model one
assert.deepStrictEqual(parseModelWeekly({ 'anthropic-ratelimit-unified-7d-utilization': '0.3' }), []);
// nor the 5h window
assert.deepStrictEqual(parseModelWeekly({ 'anthropic-ratelimit-unified-5h-opus-utilization': '0.3' }), []);
// unparseable values are dropped, not rendered as NaN%
assert.deepStrictEqual(parseModelWeekly({ 'anthropic-ratelimit-unified-7d-fable-utilization': 'n/a' }), []);
// header casing is not guaranteed by HTTP
assert.deepStrictEqual(
  parseModelWeekly({ 'Anthropic-RateLimit-Unified-7d-Fable-Utilization': '0.6' }),
  [{ model: 'fable', pct: 60, reset: 0 }]);

// ── modelLabel ────────────────────────────────────────
assert.strictEqual(modelLabel('fable'), 'Fable');
assert.strictEqual(modelLabel('opus'), 'Opus');
assert.strictEqual(modelLabel(''), '');
assert.strictEqual(modelLabel(undefined), '');

// ── parseOauthUsage ──────────────────────────────────
{
  const j = { five_hour: { utilization: 32.0, resets_at: '2026-09-05T20:59:59.710172+00:00' }, seven_day: { utilization: 20.0, resets_at: '2026-09-10T12:59:59.710194+00:00' },
    limits: [{ kind: 'session', percent: 32 }, { kind: 'weekly_all', percent: 20 }, { kind: 'weekly_scoped', percent: 39, resets_at: '2026-09-10T12:59:59.710419+00:00', scope: { model: { id: null, display_name: 'Fable' } } }] };
  const u = parseOauthUsage(j);
  assert.strictEqual(u.hourly, 32); assert.strictEqual(u.weekly, 20);
  assert.strictEqual(u.hourlyReset, Date.parse('2026-09-05T20:59:59.710172+00:00'));
  assert.strictEqual(u.weeklyReset, Date.parse('2026-09-10T12:59:59.710194+00:00'));
  assert.deepStrictEqual(u.modelWeekly, [{ model: 'fable', pct: 39, reset: Date.parse('2026-09-10T12:59:59.710419+00:00') }]);
}
assert.strictEqual(parseOauthUsage({ limits: [] }), null); // nothing usable: the caller falls back to headers
assert.strictEqual(parseOauthUsage(null), null);
assert.deepStrictEqual(parseOauthUsage({ five_hour: { utilization: 5 }, seven_day: null }), { hourly: 5 }); // partial answers still count
{ const u = parseOauthUsage({ seven_day: { utilization: 1 }, limits: [{ kind: 'weekly_scoped', percent: 7, scope: { model: { id: 'opus-x', display_name: null } } }] }); assert.deepStrictEqual(u.modelWeekly, [{ model: 'opus-x', pct: 7, reset: 0 }]); }

console.log('ok — all usage-core checks passed');
