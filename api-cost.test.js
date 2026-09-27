// Run: node api-cost.test.js
const assert = require('assert');
const { priceFor, usageCost, parseLine } = require('./api-cost');

const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);

// model ids resolve to the right price row
assert.strictEqual(priceFor('claude-opus-5-5').in, 4);
assert.strictEqual(priceFor('claude-opus-5').in, 5);
assert.strictEqual(priceFor('claude-opus-4-1-20250805').in, 15);
assert.strictEqual(priceFor('claude-opus-4-20250514').in, 15);
assert.strictEqual(priceFor('claude-opus-4-8').in, 5);
assert.strictEqual(priceFor('claude-fable-5-1').read, 0.25);
assert.strictEqual(priceFor('claude-fable-5').read, 1);
assert.strictEqual(priceFor('claude-sonnet-5').in, 2);
assert.strictEqual(priceFor('claude-sonnet-4-6').in, 3);
assert.strictEqual(priceFor('claude-haiku-4-5-20251001').in, 1);
assert.strictEqual(priceFor('<synthetic>'), null);

// 1M of each token kind on Opus 5.5: 4 in + 20 out + 0.2 read + 1h write 2x4 = 32.2
near(usageCost({ input_tokens: 1e6, output_tokens: 1e6, cache_read_input_tokens: 1e6, cache_creation_input_tokens: 1e6,
  cache_creation: { ephemeral_1h_input_tokens: 1e6, ephemeral_5m_input_tokens: 0 } }, 'claude-opus-5-5'), 32.2);
// no TTL breakdown -> 5-min write rate
near(usageCost({ cache_creation_input_tokens: 1e6 }, 'claude-opus-5'), 6.25);
near(usageCost({ output_tokens: 1e6, speed: 'fast' }, 'claude-opus-5'), 50);
assert.strictEqual(usageCost({ output_tokens: 5 }, '<synthetic>'), 0);

// transcript lines
const line = JSON.stringify({ type: 'assistant', requestId: 'r1', timestamp: '2026-09-27T14:04:47.197Z',
  message: { id: 'm1', model: 'claude-opus-5-5', usage: { output_tokens: 1e6 } } });
const r = parseLine(line);
assert.strictEqual(r.k, 'm1:r1'); near(r.c, 20); assert.strictEqual(r.t, Date.parse('2026-09-27T14:04:47.197Z'));
assert.strictEqual(parseLine('{"type":"user","message":{"content":"usage assistant"}}'), null);
assert.strictEqual(parseLine('not json "usage" "assistant"'), null);
console.log('api-cost ok');
