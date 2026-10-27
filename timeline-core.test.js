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
  assert.deepStrictEqual(parse({ type: 'user', message: { content: [{ type: 'text', text: 'Your Claude process crashed and your session was cut off, so it was resumed. Your running tools…' }] } }), [{ type: 'resumed', ts: null, text: 'Your Claude process crashed' }]);
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

test('Claude Code\'s "[Image: source: …]" lines are not a prompt of their own', () => {
  assert.deepStrictEqual(parse({ type: 'user', message: { content: '[Image: source: C:/t/a.png][Image: source: C:/t/b.png]' } }), [{ type: 'images', ts: null, paths: ['C:/t/a.png', 'C:/t/b.png'] }]);
  assert.strictEqual(parse({ type: 'user', message: { content: 'look [Image: source: C:/t/a.png]' } })[0].text, 'look');
});

test('API errors, token use, background shells and their end become events', () => {
  assert.deepStrictEqual(parse({ type: 'assistant', isApiErrorMessage: true, error: 'rate_limit', message: { content: [{ type: 'text', text: 'limit reached' }] } }), [{ type: 'apierror', ts: null, text: 'limit reached', kind: 'rate_limit' }]);
  const [t] = parse({ type: 'assistant', message: { model: 'claude-opus-5-5', usage: { input_tokens: 5, output_tokens: 7, cache_read_input_tokens: 100, cache_creation_input_tokens: 3 }, content: [{ type: 'text', text: 'hi' }] } });
  assert.deepStrictEqual(t.u, { m: 'claude-opus-5-5', i: 5, o: 7, cr: 100, cw: 3 });
  const [d] = parse({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't', content: 'Command running in background with ID: b2k. Output is being written to: C:\\t\\b2k.output. You will be notified' }] } });
  assert.strictEqual(d.bgId, 'b2k'); assert.strictEqual(d.bgOut, 'C:\\t\\b2k.output');
  assert.deepStrictEqual(parse({ type: 'user', message: { content: '<task-notification><task-id>b2k</task-id><status>completed</status></task-notification>' } }), [{ type: 'bgdone', ts: null, taskId: 'b2k', status: 'completed' }]);
});

test('an Artifact call keeps its title and the published page link', () => {
  const [u] = parse({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'a1', name: 'Artifact', input: { file_path: 'C:/s/report.html', title: 'Release notes', description: 'What shipped' } }] } });
  assert.deepStrictEqual(u.args, { file_path: 'C:/s/report.html', title: 'Release notes', description: 'What shipped' });
  const [d] = parse({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'a1', content: 'Published: https://claude.ai/code/artifact/0b1c-22 (private)' }] } });
  assert.strictEqual(d.artifactUrl, 'https://claude.ai/code/artifact/0b1c-22');
});

test('the permission mode and a compaction become events', () => {
  assert.deepStrictEqual(parse({ type: 'permission-mode', permissionMode: 'plan' }), [{ type: 'mode', ts: null, mode: 'plan' }]);
  assert.deepStrictEqual(parse({ type: 'system', subtype: 'compact_boundary', timestamp: 't' }), [{ type: 'compact', ts: 't' }]);
});

test('tool output from content blocks is joined, errors flagged', () => {
  const [ev] = parse({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }] } });
  assert.deepStrictEqual(ev, { type: 'tool_done', ts: null, toolId: 't1', text: 'a\nb', err: true });
});
