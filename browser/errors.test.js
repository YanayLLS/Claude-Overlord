const test = require('node:test');
const assert = require('node:assert');
const { createErrorBuffer, ERROR_BUFFER_MAX } = require('./errors');

const entry = (message) => ({ kind: 'console', level: 'error', message, source: 'a.js', line: 3 });

// browser/input-rebind.js re-executes the page to re-bind input. Without this
// gate every console error from the first load would be recorded twice.
test('a suppressed buffer drops pushes instead of duplicating the first load', () => {
  let suppressed = false;
  const seen = [];
  const buf = createErrorBuffer((count) => seen.push(count), () => suppressed);
  buf.push(entry('real'));
  suppressed = true;
  buf.push(entry('duplicate-from-rebind-load'));
  suppressed = false;
  assert.strictEqual(buf.count(), 1);
  assert.match(buf.format(), /real/);
  assert.doesNotMatch(buf.format(), /duplicate/);
  assert.deepStrictEqual(seen, [1], 'no onChange for a suppressed push');
});

test('suppression does not lose what was buffered before it', () => {
  let suppressed = false;
  const buf = createErrorBuffer(() => {}, () => suppressed);
  buf.push(entry('first-load'));
  suppressed = true;
  buf.push(entry('rebind'));
  suppressed = false;
  buf.push(entry('after'));
  assert.strictEqual(buf.count(), 2);
  assert.match(buf.format(), /first-load/);
});

test('starts empty', () => {
  const buf = createErrorBuffer(() => {});
  assert.strictEqual(buf.count(), 0);
  assert.deepStrictEqual(buf.list(), []);
});

test('push appends and reports count', () => {
  const buf = createErrorBuffer(() => {});
  buf.push(entry('boom'));
  assert.strictEqual(buf.count(), 1);
  assert.strictEqual(buf.list()[0].message, 'boom');
});

test('push stamps a timestamp', () => {
  const buf = createErrorBuffer(() => {});
  buf.push(entry('boom'));
  assert.strictEqual(typeof buf.list()[0].ts, 'number');
});

test('drops oldest beyond ERROR_BUFFER_MAX', () => {
  const buf = createErrorBuffer(() => {});
  for (let i = 0; i < ERROR_BUFFER_MAX + 5; i++) buf.push(entry('e' + i));
  assert.strictEqual(buf.count(), ERROR_BUFFER_MAX);
  assert.strictEqual(buf.list()[0].message, 'e5');
});

test('onChange fires with count and last entry', () => {
  const seen = [];
  const buf = createErrorBuffer((count, last) => seen.push([count, last && last.message]));
  buf.push(entry('boom'));
  assert.deepStrictEqual(seen, [[1, 'boom']]);
});

test('clear empties and notifies once', () => {
  const seen = [];
  const buf = createErrorBuffer((count, last) => seen.push([count, last]));
  buf.push(entry('boom'));
  seen.length = 0;
  buf.clear();
  assert.strictEqual(buf.count(), 0);
  assert.deepStrictEqual(seen, [[0, null]]);
});

test('clear on an empty buffer does not notify', () => {
  const seen = [];
  const buf = createErrorBuffer((count) => seen.push(count));
  buf.clear();
  assert.deepStrictEqual(seen, []);
});

test('format renders kind, level, source and message', () => {
  const buf = createErrorBuffer(() => {});
  buf.push(entry('boom'));
  assert.strictEqual(buf.format(), '[CONSOLE/error] a.js:3 — boom');
});

test('format omits location when source is absent', () => {
  const buf = createErrorBuffer(() => {});
  buf.push({ kind: 'network', level: 'error', message: 'ERR_FAILED', source: '', line: 0 });
  assert.strictEqual(buf.format(), '[NETWORK/error] — ERR_FAILED');
});
