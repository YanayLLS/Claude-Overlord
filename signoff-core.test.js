// Run: node signoff-core.test.js
const assert = require('assert');
const { openerMark, reviewMark, signoff, hasSigned } = require('./signoff-core');

const team = ['Alice', 'bob', 'carol'];
const pr = (author, body = '') => ({ user: { login: author }, body, head: { sha: 'h2' } });
const rev = (login, state, t, sha = 'h2', body = '') => ({ user: { login }, state, submitted_at: `2026-09-29T10:0${t}:00Z`, commit_id: sha, body });

// opener on the team counts as signature 1, with the ClickUp id from its body mark
{
  const s = signoff(pr('alice', 'x\n' + openerMark('alice', '111')), [], team);
  assert.deepStrictEqual(s.signers, [{ login: 'alice', via: 'opened', clickup: '111' }]);
  assert.strictEqual(s.ok, false);
}
// opener + one approval from another member on the current head = signed
{
  const s = signoff(pr('alice'), [rev('bob', 'APPROVED', 1, 'h2', reviewMark('222'))], team);
  assert.deepStrictEqual(s.signers.map(x => x.login + ':' + x.via + ':' + x.clickup), ['alice:opened:null', 'bob:approved:222']);
  assert.strictEqual(s.ok, true);
  assert.ok(hasSigned(s, 'BOB'));
}
// an approval on an older commit doesn't count; a later "changes requested" withdraws it
assert.strictEqual(signoff(pr('alice'), [rev('bob', 'APPROVED', 1, 'h1')], team).ok, false);
assert.strictEqual(signoff(pr('alice'), [rev('bob', 'APPROVED', 1), rev('bob', 'CHANGES_REQUESTED', 2)], team).ok, false);
// a COMMENTED review after an approval doesn't withdraw it
assert.strictEqual(signoff(pr('alice'), [rev('bob', 'APPROVED', 1), rev('bob', 'COMMENTED', 2)], team).ok, true);
// someone off the team: neither opening nor approving counts
assert.strictEqual(signoff(pr('mallory'), [rev('bob', 'APPROVED', 1)], team).count, 1);
assert.strictEqual(signoff(pr('alice'), [rev('mallory', 'APPROVED', 1)], team).ok, false);
// a non-member opener still needs two members' approvals
assert.strictEqual(signoff(pr('mallory'), [rev('bob', 'APPROVED', 1), rev('carol', 'APPROVED', 2)], team).ok, true);
// an opener mark naming someone else doesn't lend them its ClickUp id
assert.strictEqual(signoff(pr('alice', openerMark('bob', '999')), [], team).signers[0].clickup, null);

console.log('signoff-core: all passed');
