const test = require('node:test');
const assert = require('node:assert');
const { promptKey, recordHasPrompt, linesHavePrompt } = require('./follow-core');

const T0 = Date.parse('2026-09-29T12:00:00Z');
const user = (content, ts = '2026-09-29T12:00:03Z') => ({ type: 'user', timestamp: ts, message: { role: 'user', content } });

test('promptKey skips slash commands and blips, normalizes whitespace', () => {
  assert.strictEqual(promptKey('/resume'), null);
  assert.strictEqual(promptKey('ok'), null);
  assert.strictEqual(promptKey('  fix   the\r\nbug  '), 'fix the bug');
});

test('matches string and block content written after the submit', () => {
  const key = promptKey('why is staging shown as needs me?');
  assert.ok(recordHasPrompt(user('why is staging shown as needs me?'), key, T0));
  assert.ok(recordHasPrompt(user([{ type: 'text', text: 'why is staging\nshown as needs me?' }, { type: 'image' }]), key, T0));
});

test('ignores older records, other text, and non-user records', () => {
  const key = promptKey('why is staging shown as needs me?');
  assert.ok(!recordHasPrompt(user('why is staging shown as needs me?', '2026-09-29T11:00:00Z'), key, T0));
  assert.ok(!recordHasPrompt(user('something else'), key, T0));
  assert.ok(!recordHasPrompt({ type: 'assistant', timestamp: '2026-09-29T12:00:03Z', message: { content: 'why is staging shown as needs me?' } }, key, T0));
});

test('linesHavePrompt scans a JSONL tail', () => {
  const key = promptKey('run the tests');
  const lines = [JSON.stringify({ type: 'assistant' }), 'not json {', JSON.stringify(user('run the tests'))];
  assert.ok(linesHavePrompt(lines, key, T0));
  assert.ok(!linesHavePrompt(lines.slice(0, 2), key, T0));
});
