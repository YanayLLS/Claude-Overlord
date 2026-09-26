const test = require('node:test');
const assert = require('node:assert');
const { applyAskRecord } = require('./ask-core');

const ask = (id, name = 'AskUserQuestion') => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name }] } });
const result = (id) => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id }] } });

test('open until its own result arrives', () => {
  const s = new Set();
  assert.strictEqual(applyAskRecord(s, ask('t1')), true);
  applyAskRecord(s, { type: 'queue-operation', operation: 'enqueue', content: '<task-notification>...' });
  applyAskRecord(s, result('other'));
  assert.deepStrictEqual([...s], ['t1']);
  assert.strictEqual(applyAskRecord(s, result('t1')), true);
  assert.strictEqual(s.size, 0);
});

test('ExitPlanMode counts; other tools do not', () => {
  const s = new Set();
  applyAskRecord(s, ask('p1', 'ExitPlanMode'));
  applyAskRecord(s, ask('b1', 'Bash'));
  assert.deepStrictEqual([...s], ['p1']);
});

test('turn end clears (interrupted / abandoned ask)', () => {
  const s = new Set(['t1']);
  applyAskRecord(s, { type: 'system', subtype: 'turn_duration' });
  assert.strictEqual(s.size, 0);
});
