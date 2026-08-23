const test = require('node:test');
const assert = require('node:assert');
const { TOOL_SCHEMAS, createDispatcher } = require('./tools');

function fakeActions(overrides = {}) {
  const calls = [];
  const base = {
    navigate: async (url) => { calls.push(['navigate', url]); return 'loaded ' + url; },
    snapshot: async () => { calls.push(['snapshot']); return 'button "Go" [ref_1]'; },
    screenshot: async () => { calls.push(['screenshot']); return 'QUJD'; },
    click: async (ref) => { calls.push(['click', ref]); return 'clicked ' + ref; },
    type: async (ref, text, submit) => { calls.push(['type', ref, text, submit]); return 'typed'; },
    consoleErrors: async () => { calls.push(['consoleErrors']); return 'no errors'; },
    evaluate: async (js) => { calls.push(['evaluate', js]); return '42'; },
  };
  return { actions: { ...base, ...overrides }, calls };
}

test('exposes exactly the seven browser tools', () => {
  const names = TOOL_SCHEMAS.map((t) => t.name).sort();
  assert.deepStrictEqual(names, [
    'browser_click', 'browser_console', 'browser_eval', 'browser_navigate',
    'browser_screenshot', 'browser_snapshot', 'browser_type',
  ]);
});

test('every schema has a description and an object inputSchema', () => {
  for (const t of TOOL_SCHEMAS) {
    assert.ok(t.description.length > 10, `${t.name} needs a description`);
    assert.strictEqual(t.inputSchema.type, 'object');
  }
});

test('navigate passes the url through and returns a text block', async () => {
  const { actions, calls } = fakeActions();
  const res = await createDispatcher(actions)('browser_navigate', { url: 'http://localhost:3000' });
  assert.deepStrictEqual(calls, [['navigate', 'http://localhost:3000']]);
  assert.deepStrictEqual(res, { content: [{ type: 'text', text: 'loaded http://localhost:3000' }] });
});

test('screenshot returns an image block, not text', async () => {
  const { actions } = fakeActions();
  const res = await createDispatcher(actions)('browser_screenshot', {});
  assert.deepStrictEqual(res.content, [{ type: 'image', data: 'QUJD', mimeType: 'image/png' }]);
});

test('type forwards submit as a boolean, defaulting to false', async () => {
  const { actions, calls } = fakeActions();
  await createDispatcher(actions)('browser_type', { ref: 'ref_2', text: 'hi' });
  assert.deepStrictEqual(calls, [['type', 'ref_2', 'hi', false]]);
});

test('unknown tool name is an error result, not a throw', async () => {
  const { actions } = fakeActions();
  const res = await createDispatcher(actions)('browser_teleport', {});
  assert.strictEqual(res.isError, true);
  assert.match(res.content[0].text, /Unknown tool: browser_teleport/);
});

test('a missing required argument is an error result', async () => {
  const { actions } = fakeActions();
  const res = await createDispatcher(actions)('browser_click', {});
  assert.strictEqual(res.isError, true);
  assert.match(res.content[0].text, /ref/);
});

test('an action that throws becomes an error result', async () => {
  const { actions } = fakeActions({ navigate: async () => { throw new Error('ERR_CONNECTION_REFUSED'); } });
  const res = await createDispatcher(actions)('browser_navigate', { url: 'http://localhost:1' });
  assert.strictEqual(res.isError, true);
  assert.match(res.content[0].text, /ERR_CONNECTION_REFUSED/);
});
