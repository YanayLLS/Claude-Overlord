// Run: node pr-behind.test.js
const assert = require('assert');
const { buildBehindQuery, parseBehind, prBranchAction } = require('./pr-behind');

assert.strictEqual(buildBehindQuery([]), null);
assert.strictEqual(buildBehindQuery(null), null);
// a PR with no branch names can't be compared
assert.strictEqual(buildBehindQuery([{ key: 'k', repo: 'o/r', headRef: '', baseRef: 'main' }]), null);

const prs = [
  { key: 'o/r#1', repo: 'o/r', headRef: 'feat/a', baseRef: 'main' },
  { key: 'o/r#2', repo: 'o/r', headRef: 'feat/b', baseRef: 'main' },
  { key: 'x/y#3', repo: 'x/y', headRef: 'fix"quote', baseRef: 'dev' },
];
const q = buildBehindQuery(prs);
assert.deepStrictEqual(q.keys, ['o/r#1', 'o/r#2', 'x/y#3']);
assert.ok(q.query.includes('b0: repository(owner:"o", name:"r")'));
assert.ok(q.query.includes('ref(qualifiedName:"dev")'));
assert.ok(q.query.includes('compare(headRef:"fix\\"quote")')); // quotes escaped, not injected

// unusable PRs are dropped, so aliases must stay aligned with the returned keys
const mixed = buildBehindQuery([{ key: 'skip', repo: 'o/r', baseRef: 'main' }, prs[0]]);
assert.deepStrictEqual(mixed.keys, ['o/r#1']);
assert.ok(mixed.query.includes('b0: repository'));

assert.deepStrictEqual(parseBehind({
  data: {
    b0: { ref: { compare: { behindBy: 3 } } },
    b1: { ref: { compare: { behindBy: 0 } } },
    b2: { ref: null }, // deleted base branch
  },
}, q.keys), { 'o/r#1': 3, 'o/r#2': 0 });

assert.deepStrictEqual(parseBehind({ errors: [{ message: 'boom' }] }, q.keys), {});
assert.deepStrictEqual(parseBehind(null, q.keys), {});
assert.deepStrictEqual(parseBehind({ data: {} }, null), {});

// prBranchAction — only the author gets a branch button
assert.strictEqual(prBranchAction({ mine: false, behindBy: 5 }), null);
assert.strictEqual(prBranchAction({ mine: false, mergeable: 'CONFLICTING' }), null);
assert.strictEqual(prBranchAction(null), null);
assert.strictEqual(prBranchAction({ mine: true, behindBy: 0 }), null);
assert.strictEqual(prBranchAction({ mine: true, behindBy: null }), null); // behind unknown
assert.strictEqual(prBranchAction({ mine: true, behindBy: 5 }), 'update');
// conflicts beat behind — updating is impossible until they're resolved
assert.strictEqual(prBranchAction({ mine: true, behindBy: 5, mergeable: 'CONFLICTING' }), 'conflict');
assert.strictEqual(prBranchAction({ mine: true, behindBy: 0, mergeState: 'DIRTY' }), 'conflict');

console.log('pr-behind: all tests passed');
