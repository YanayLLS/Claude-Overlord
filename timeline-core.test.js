const test = require('node:test');
const assert = require('node:assert');
const { parseLineForTimeline } = require('./timeline-core');

const fmt = (n) => 'Using ' + n;
const sys = (t) => t.startsWith('<system-reminder>');
const parse = (r) => parseLineForTimeline(JSON.stringify(r), fmt, sys);

test('an Edit carries its before/after for the diff', () => {
  const [ev] = parse({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: 'C:/a/b.js', old_string: 'x', new_string: 'y' } }] } });
  assert.deepStrictEqual(ev.args, { file_path: 'C:/a/b.js', old: 'x', new: 'y' });
  assert.strictEqual(ev.text, 'Using Edit');
});

test('a slash command becomes one /name line, an interrupt its own marker', () => {
  assert.deepStrictEqual(parse({ type: 'user', message: { content: '<command-name>/model</command-name><command-args>opus</command-args>' } }), [{ type: 'command', ts: null, text: '/model opus' }]);
  assert.deepStrictEqual(parse({ type: 'user', message: { content: [{ type: 'text', text: '[Request interrupted by user]' }] } }), [{ type: 'interrupt', ts: null }]);
});

test('a message typed mid-turn shows as a prompt; reminders do not', () => {
  assert.strictEqual(parse({ type: 'attachment', attachment: { type: 'queued_command', prompt: 'dont push', origin: { kind: 'human' } } })[0].text, 'dont push');
  assert.strictEqual(parse({ type: 'attachment', attachment: { type: 'queued_command', prompt: 'x', origin: { kind: 'agent' } } }), null);
  assert.strictEqual(parse({ type: 'user', message: { content: '<system-reminder>hi</system-reminder>' } }), null);
});

test('a pasted image rides along as a data URL', () => {
  const [ev] = parse({ type: 'user', message: { content: [{ type: 'text', text: 'see [Image #1]' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }] } });
  assert.deepStrictEqual(ev.images, ['data:image/png;base64,AAAA']);
});

test('tool output from content blocks is joined, errors flagged', () => {
  const [ev] = parse({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }] } });
  assert.deepStrictEqual(ev, { type: 'tool_done', ts: null, toolId: 't1', text: 'a\nb', err: true });
});
