// Run: node branch-ahead.test.js
const assert = require('assert');
const { remoteRepo, aheadSummary } = require('./branch-ahead');

assert.strictEqual(remoteRepo('git@github.com:LLSLtd/frontlineio-frontend.git'), 'LLSLtd/frontlineio-frontend');
assert.strictEqual(remoteRepo('https://github.com/LLSLtd/back-office'), 'LLSLtd/back-office');
assert.strictEqual(remoteRepo('https://github.com/LLSLtd/back-office.git/'), 'LLSLtd/back-office');
assert.strictEqual(remoteRepo('ssh://git@github.com/o/r.git'), 'o/r');
assert.strictEqual(remoteRepo('git@gitlab.com:o/r.git'), ''); // not GitHub — no repo key to match on
assert.strictEqual(remoteRepo(''), '');
assert.strictEqual(remoteRepo(null), '');

assert.strictEqual(aheadSummary([], 'dev'), null);
assert.strictEqual(aheadSummary(null, 'dev'), null);
assert.strictEqual(aheadSummary([{ branch: 'feat/a', count: 0 }], 'dev'), null); // level with dev = no badge

const one = aheadSummary([{ branch: 'feat/a', count: 1 }], 'dev');
assert.strictEqual(one.count, 1);
assert.strictEqual(one.title, '1 commit on feat/a not in dev'); // singular

// Biggest wins the number, every branch shows in the tooltip.
const many = aheadSummary([{ branch: 'feat/a', count: 2 }, { branch: 'feat/b', count: 9 }], 'dev');
assert.strictEqual(many.count, 9);
assert.strictEqual(many.title, '9 commits on feat/b not in dev\n2 commits on feat/a not in dev');

console.log('branch-ahead.test.js OK');
