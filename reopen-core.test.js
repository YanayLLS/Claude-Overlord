const test = require('node:test');
const assert = require('node:assert');
const { nextReopen, noteArchived } = require('./reopen-core');

const ag = (o) => new Map(Object.entries(o).map(([k, v]) => [Number(k), v]));

test('walks the stack newest first, skipping agents unarchived or deleted meanwhile', () => {
  const stack = [1, 2, 3];
  const agents = ag({ 1: { archived: true }, 3: { archived: false } }); // 2 deleted, 3 already back
  assert.strictEqual(nextReopen(stack, agents), 1);
  assert.deepStrictEqual(stack, []);
});

test('empty stack (after a reload): the most recently archived agent, then the one before', () => {
  const agents = ag({ 1: { archived: true, archivedAt: 100 }, 2: { archived: true, archivedAt: 300 }, 3: { archived: true, archivedAt: 200 }, 4: { archived: false, archivedAt: 900 } });
  assert.strictEqual(nextReopen([], agents), 2);
  agents.get(2).archived = false;
  assert.strictEqual(nextReopen([], agents), 3);
  agents.get(3).archived = false;
  assert.strictEqual(nextReopen([], agents), 1);
  agents.get(1).archived = false;
  assert.strictEqual(nextReopen([], agents), null);
});

test('archived agents without a time (older state files) come after timed ones, higher id first', () => {
  const agents = ag({ 5: { archived: true }, 7: { archived: true }, 6: { archived: true, archivedAt: 1 } });
  assert.strictEqual(nextReopen([], agents), 6);
  agents.get(6).archived = false;
  assert.strictEqual(nextReopen([], agents), 7);
});

test('noteArchived: newest last, an id archived again moves to the top', () => {
  const stack = [1, 2];
  noteArchived(stack, 1);
  assert.deepStrictEqual(stack, [2, 1]);
  noteArchived(stack, 3);
  assert.deepStrictEqual(stack, [2, 1, 3]);
});
