const test = require('node:test');
const assert = require('node:assert');
const { interruptedBy } = require('./interrupt-core');

const now = Date.parse('2026-10-14T10:00:00Z');
const ts = '2026-10-14T09:00:00Z';
const j = (...rs) => rs.map(r => JSON.stringify({ timestamp: ts, ...r })).join('\n');
const said = (stop) => ({ type: 'assistant', message: { stop_reason: stop } });

test('turn ended cleanly → not interrupted', () => {
  assert.strictEqual(interruptedBy(j(said('tool_use'), said('end_turn'), { type: 'system', subtype: 'turn_duration' }), now), null);
});
test('died mid tool call', () => assert.strictEqual(interruptedBy(j(said('end_turn'), said('tool_use')), now), 'mid-task'));
test('idle but a background agent was running', () => {
  assert.strictEqual(interruptedBy(j({ type: 'user', toolUseResult: { status: 'async_launched', agentId: 'a1' } }, said('end_turn')), now), 'background work');
});
test('old transcript is ignored', () => assert.strictEqual(interruptedBy(j(said('tool_use')), now + 4 * 86400e3), null));
test('cut first line is skipped', () => assert.strictEqual(interruptedBy('e":"x"}\n' + j(said('tool_use')), now), 'mid-task'));
