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
assert.deepStrictEqual(signoff(pr('alice'), [rev('bob', 'APPROVED', 1, 'h1')], team).stale, ['bob']);
{ // the release is signed as one: bob counts only once he signed every PR at its current commit
  const { releaseSignoff } = require('./signoff-core');
  const a = { label: 'a', signoff: signoff(pr('alice'), [rev('bob', 'APPROVED', 1)], team) };
  const b = { label: 'b', signoff: signoff(pr('alice'), [rev('bob', 'APPROVED', 1, 'h1')], team) };
  const c = { label: 'c', signoff: signoff(pr('alice'), [], team) };
  const r = releaseSignoff([a, b, c]);
  assert.deepStrictEqual([r.count, r.ok, r.signers.map(x => x.login)], [1, false, ['alice']]);
  assert.deepStrictEqual(r.gaps, [{ login: 'bob', missing: [{ label: 'b', older: true }, { label: 'c', older: false }] }]);
  assert.strictEqual(releaseSignoff([a]).ok, true);
}
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
{ // the opener's signature covers the commit it was stamped on: new commits void it
  const at = (body) => ({ ...pr('alice', body), head: { sha: 'abcdef2' } });
  const fresh = signoff(at(openerMark('alice', '1', 'abcdef2')), [], team);
  const old = signoff(at(openerMark('alice', '1', 'abcdef1')), [], team);
  assert.deepStrictEqual([fresh.count, old.count, old.stale], [1, 0, ['alice']]);
  assert.strictEqual(signoff(pr('alice', openerMark('alice', '1')), [], team).count, 1, 'marks from before shas still count');
}

console.log('signoff-core: all passed');
