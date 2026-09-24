const test = require('node:test');
const assert = require('node:assert');
const { applyBgRecord } = require('./bg-core');

const note = (id, status, extra = '') => `<task-notification>\n<task-id>${id}</task-id>\n<status>${status}</status>\n${extra}</task-notification>`;

test('background shell: launch then completion', () => {
  const t = new Set();
  assert.strictEqual(applyBgRecord(t, { type: 'user', toolUseResult: { backgroundTaskId: 'b1' } }), true);
  assert.deepStrictEqual([...t], ['b1']);
  applyBgRecord(t, { type: 'user', message: { content: note('b1', 'completed') } });
  assert.strictEqual(t.size, 0);
});

test('async agent: launch, interim finish with own bg work, final finish', () => {
  const t = new Set();
  applyBgRecord(t, { type: 'user', toolUseResult: { isAsync: true, status: 'async_launched', agentId: 'a1' } });
  applyBgRecord(t, { type: 'queue-operation', content: note('a1', 'completed', '<note>This agent stopped with background work of its own still running.</note>') });
  assert.deepStrictEqual([...t], ['a1']);
  applyBgRecord(t, { type: 'queue-operation', content: note('a1', 'completed') });
  assert.strictEqual(t.size, 0);
});

test('agent resumed after a final notification is pending again when it reports bg work', () => {
  const t = new Set();
  applyBgRecord(t, { type: 'user', message: { content: note('a1', 'stopped') } });
  applyBgRecord(t, { type: 'user', message: { content: note('a1', 'completed', '<note>This agent stopped with background work of its own still running.</note>') } });
  assert.deepStrictEqual([...t], ['a1']);
});

test('killed / failed end the task; array content works', () => {
  const t = new Set(['b1', 'b2']);
  applyBgRecord(t, { type: 'user', message: { content: [{ type: 'text', text: note('b1', 'killed') + note('b2', 'failed') }] } });
  assert.strictEqual(t.size, 0);
});

test('one notification ending several tasks', () => {
  const t = new Set(['b1', 'b2', 'b3']);
  applyBgRecord(t, { type: 'queue-operation', content: '<task-notification>\n<task-id>b1</task-id>\n<task-id>b2</task-id>\n<status>stopped</status>\n</task-notification>' });
  assert.deepStrictEqual([...t], ['b3']);
});

test('SendMessage resuming a finished agent makes it pending again', () => {
  const t = new Set();
  applyBgRecord(t, { type: 'user', toolUseResult: { success: true, message: 'Resuming agent a1', resumedAgentId: 'a1' } });
  assert.deepStrictEqual([...t], ['a1']);
});

test('TaskStop ends a task (no notification follows)', () => {
  const t = new Set(['b1']);
  applyBgRecord(t, { type: 'user', toolUseResult: { message: 'Successfully stopped task: b1 (npm test)', task_id: 'b1' } });
  assert.strictEqual(t.size, 0);
});

test('assistant text quoting a notification is ignored', () => {
  const t = new Set(['b1']);
  applyBgRecord(t, { type: 'assistant', message: { content: [{ type: 'text', text: note('b1', 'completed') }] } });
  assert.strictEqual(t.size, 1);
});
