// Run: node usage-core.test.js
const assert = require('assert');
const { parseModelWeekly, modelLabel } = require('./usage-core');

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

console.log('ok — all usage-core checks passed');
