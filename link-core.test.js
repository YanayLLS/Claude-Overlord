// Self-check for link-core. Run: node link-core.test.js
const assert = require('assert');
const { linksAt } = require('./link-core');

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
  const [l] = linksAt(hard, y, cols);
  assert.strictEqual(l.text, full);
  assert.deepStrictEqual(l.start, { x: 7, y: 1 });
  assert.deepStrictEqual(l.end, { x: 10, y: 2 });
}
assert.deepStrictEqual(linksAt(hard, 2, cols), []);

// Soft wrap: joined as-is, no indent stripping.
const soft = buf(['https://a.io/' + 'x'.repeat(17), { text: 'yz end'.padEnd(cols), isWrapped: true }]);
assert.strictEqual(linksAt(soft, 1, cols)[0].text, 'https://a.io/' + 'x'.repeat(17) + 'yz');

// Short row: no join, URL stays on its own row.
const short = buf(['go https://b.io/p', 'more text']);
assert.strictEqual(linksAt(short, 0, cols)[0].text, 'https://b.io/p');
assert.deepStrictEqual(linksAt(short, 1, cols), []);

// Hard-wrapped Windows path (the screenshot case): the .txt tail belongs to the link.
const pcols = 40;
const pbuf = (rows) => (i) => rows[i] === undefined ? null : { text: rows[i].padEnd(pcols), isWrapped: false };
const pth = pbuf(['  312 C:\\Users\\y\\AppData\\Local\\Temp\\fails', '  .txt', '  regression/1: 5 failed']);
for (const y of [0, 1]) {
  const [l] = linksAt(pth, y, pcols);
  assert.strictEqual(l.kind, 'path');
  assert.strictEqual(l.text, 'C:\\Users\\y\\AppData\\Local\\Temp\\fails.txt');
}

// A URL is one url link, not also a "//host" path.
assert.deepStrictEqual(linksAt(short, 0, cols).map(l => l.kind), ['url']);

console.log('link-core ok');
