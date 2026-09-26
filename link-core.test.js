// Self-check for link-core. Run: node link-core.test.js
const assert = require('assert');
const { urlLinksAt } = require('./link-core');

const cols = 30;
const buf = (rows) => (i) => rows[i] === undefined ? null
  : (typeof rows[i] === 'string' ? { text: rows[i].padEnd(cols), isWrapped: false } : rows[i]);

// Hard wrap with indent (how Claude prints a long URL): both rows open the whole URL.
const hard = buf([
  '  see https://example.com/abcd',
  '  efgh/ijk done',
  'next line',
]);
const full = 'https://example.com/abcdefgh/ijk';
for (const y of [0, 1]) {
  const [l] = urlLinksAt(hard, y, cols);
  assert.strictEqual(l.url, full);
  assert.deepStrictEqual(l.start, { x: 7, y: 1 });
  assert.deepStrictEqual(l.end, { x: 10, y: 2 });
}
assert.deepStrictEqual(urlLinksAt(hard, 2, cols), []);

// Soft wrap: joined as-is, no indent stripping.
const soft = buf(['https://a.io/' + 'x'.repeat(17), { text: 'yz end'.padEnd(cols), isWrapped: true }]);
assert.strictEqual(urlLinksAt(soft, 1, cols)[0].url, 'https://a.io/' + 'x'.repeat(17) + 'yz');

// Short row: no join, URL stays on its own row.
const short = buf(['go https://b.io/p', 'more text']);
assert.strictEqual(urlLinksAt(short, 0, cols)[0].url, 'https://b.io/p');
assert.deepStrictEqual(urlLinksAt(short, 1, cols), []);

console.log('link-core ok');
