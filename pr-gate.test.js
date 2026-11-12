const test = require('node:test');
const assert = require('node:assert');
const { requiredTeamIds, parseOrgTeams, applyGates } = require('./pr-gate');

test('requiredTeamIds reads the ruleset required reviewers', () => {
  const rules = [
    { type: 'deletion' },
    { type: 'pull_request', parameters: { required_reviewers: [{ minimum_approvals: 1, reviewer: { id: 20118509, type: 'Team' } }] } },
  ];
  assert.deepStrictEqual(requiredTeamIds(rules), [20118509]);
  assert.deepStrictEqual(requiredTeamIds([{ type: 'pull_request', parameters: { required_approving_review_count: 1 } }]), []);
  assert.deepStrictEqual(requiredTeamIds({ message: 'Not Found' }), []);
});

test('parseOrgTeams maps ids to slugs and members; null without teams', () => {
  const m = parseOrgTeams({ organization: { teams: { nodes: [{ databaseId: 1, slug: 'dev-approvers', members: { nodes: [{ login: 'a' }, { login: 'b' }] } }] } } });
  assert.strictEqual(m.get(1).slug, 'dev-approvers');
  assert.ok(m.get(1).members.has('b'));
  assert.strictEqual(parseOrgTeams({ organization: null }), null);
});

const team = { slug: 'release-approvers', members: new Set(['boss']) };
const gated = (p) => (p.repo === 'o/infra' ? [team] : null);
const pr = (o) => ({ repo: 'o/infra', mine: false, isDraft: false, approvedBy: [], ...o });

test("others' gated PRs leave the to-act-on list when I'm not an approver", () => {
  const a = pr({ key: 'a' }), b = pr({ key: 'b', repo: 'o/web' }), mine = pr({ key: 'm', mine: true });
  const r = applyGates([a, b, mine], [], gated, 'me');
  assert.deepStrictEqual(r.prs.map(p => p.key), ['b', 'm']);
  assert.deepStrictEqual(r.extra.map(p => p.key), ['a']);
  assert.deepStrictEqual(a.approverTeams, ['release-approvers']);
  assert.strictEqual(a.canApprove, false);
});

test('an approver keeps it until an approver approves; a non-approver approval does not count', () => {
  const nonApproverOk = pr({ key: 'x', approvedBy: ['someone'] }); // fetchAllPRs put it in extra
  const approverOk = pr({ key: 'y', approvedBy: ['boss'] });
  const open = pr({ key: 'z' });
  const r = applyGates([open], [nonApproverOk, approverOk], gated, 'boss');
  assert.deepStrictEqual(r.prs.map(p => p.key), ['z', 'x']);
  assert.deepStrictEqual(r.extra.map(p => p.key), ['y']);
  assert.strictEqual(nonApproverOk.approvedByApprover, false);
  assert.strictEqual(approverOk.approvedByApprover, true);
});

test('drafts and unknown gates stay where they were', () => {
  const d = pr({ key: 'd', isDraft: true });
  const r = applyGates([pr({ key: 'u', repo: 'o/web' })], [d], gated, 'me');
  assert.deepStrictEqual(r.prs.map(p => p.key), ['u']);
  assert.deepStrictEqual(r.extra.map(p => p.key), ['d']);
});
