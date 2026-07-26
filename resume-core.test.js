// Run: node resume-core.test.js
const assert = require('assert');
const { pickResumedFile } = require('./resume-core');

const base = { since: 1000, current: 'a.jsonl', owned: new Set(['b.jsonl']) };

// nothing touched since the /resume — stay put
assert.strictEqual(pickResumedFile({ ...base, entries: [{ file: 'c.jsonl', mtimeMs: 900 }] }), null);
// a stale sibling that just went live is the resumed one
assert.strictEqual(pickResumedFile({ ...base, entries: [{ file: 'c.jsonl', mtimeMs: 1500 }] }), 'c.jsonl');
// the agent's own file growing is not a resume
assert.strictEqual(pickResumedFile({ ...base, entries: [{ file: 'a.jsonl', mtimeMs: 9999 }] }), null);
// another agent's session is never stolen
assert.strictEqual(pickResumedFile({ ...base, entries: [{ file: 'b.jsonl', mtimeMs: 9999 }] }), null);
// newest wins
assert.strictEqual(pickResumedFile({
  ...base, entries: [{ file: 'c.jsonl', mtimeMs: 1500 }, { file: 'd.jsonl', mtimeMs: 2500 }],
}), 'd.jsonl');
assert.strictEqual(pickResumedFile({ ...base, entries: [] }), null);
assert.strictEqual(pickResumedFile({ ...base, entries: null }), null);

console.log('resume-core: all tests passed');
