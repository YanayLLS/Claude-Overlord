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

const { permDialogIn } = require('./ask-core');
test('permission dialog on screen (sub-agent / dangerous command), with or without spaces', () => {
  const screen = 'Bash command · from the fix-D agent Run shell command │ rm -f fixD/* Dangerous rm operation on statically-unresolvable target Do you want to proceed? > 1. Yes   2. No';
  assert.ok(permDialogIn(screen));
  assert.ok(permDialogIn(screen.replace(/ /g, '')), 'spaces drawn as cursor moves');
  assert.ok(permDialogIn('Do you want to make this edit to main.js?\n❯ 1. Yes\n  2. Yes, allow all edits\n  3. No, and tell Claude'));
  assert.ok(!permDialogIn('I asked: do you want to proceed with the plan? Reply yes or no.'));
  assert.ok(!permDialogIn('Cooked for 12s · done 4:05 PM'));
});

const { liveTurnIn } = require('./ask-core');
test('live turn timer vs finished-turn line', () => {
  assert.ok(liveTurnIn('Sublimating… (10m 17s · ↓ 61.7k tokens)'));
  assert.ok(liveTurnIn('Pouncing…(14m14s·↓5.4ktokens)'), 'spaces drawn as cursor moves');
  assert.ok(liveTurnIn('Thinking… (8s · esc to interrupt)'));
  assert.ok(!liveTurnIn('Cooked for 2m 44s · done 4:05 PM'));
  assert.ok(!liveTurnIn('Churned for 1h 51m 41s · done 4:07 PM · 1 shell still running'));
});
