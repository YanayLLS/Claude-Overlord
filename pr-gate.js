// Repos whose rulesets name required reviewers (e.g. servers-infrastructure: dev needs @dev-approvers, main needs
// @release-approvers) only count approvals from those teams. Such a PR isn't the viewer's to act on unless they're
// in one of the teams, and a teammate's approval from outside them doesn't mean it stopped waiting.

// Team ids a branch's rules require a review from (GET /repos/{r}/rules/branches/{b}). File patterns are ignored:
// treated as covering every PR, which is what the rules in use today say.
function requiredTeamIds(rules) {
  const ids = [];
  for (const r of Array.isArray(rules) ? rules : []) {
    if (!r || r.type !== 'pull_request') continue;
    for (const rr of (r.parameters && r.parameters.required_reviewers) || []) {
      const rv = rr && rr.reviewer;
      if (rv && rv.type === 'Team' && rv.id != null && !ids.includes(rv.id)) ids.push(rv.id);
    }
  }
  return ids;
}

function orgTeamsQuery(org) {
  return `query { organization(login:${JSON.stringify(org)}) { teams(first:100) { nodes { databaseId slug members(first:100) { nodes { login } } } } } }`;
}

// → Map(team id → { slug, members:Set(login) }), or null when the answer has no teams (no read:org scope, etc.).
function parseOrgTeams(data) {
  const nodes = data && data.organization && data.organization.teams && data.organization.teams.nodes;
  if (!Array.isArray(nodes)) return null;
  const m = new Map();
  for (const t of nodes) {
    if (!t || t.databaseId == null) continue;
    m.set(t.databaseId, { slug: t.slug || String(t.databaseId), members: new Set(((t.members && t.members.nodes) || []).map(n => n && n.login).filter(Boolean)) });
  }
  return m;
}

// gateFor(pr) → [{ slug, members:Set }] for a gated PR, or null when it isn't gated or that's unknown (then the PR is
// left where fetchAllPRs put it). Moves others' gated PRs between the "to act on" list and the "All open" extras, and
// stamps each gated PR with `approverTeams` (slugs) and `approvedByApprover`.
function applyGates(prs, extra, gateFor, me) {
  const keep = [], more = [];
  const place = (p, inPrs) => {
    const teams = gateFor(p);
    if (!teams || !teams.length) { (inPrs ? keep : more).push(p); return; }
    const isApprover = (login) => teams.some(t => t.members.has(login));
    p.approverTeams = teams.map(t => t.slug);
    p.approvedByApprover = (p.approvedBy || []).some(isApprover);
    p.canApprove = !!me && isApprover(me);
    // Mine and drafts stay put; the approval stamp still tells the row whether an approval counts.
    if (p.mine || p.isDraft) { (inPrs ? keep : more).push(p); return; }
    (p.canApprove && !p.approvedByApprover ? keep : more).push(p);
  };
  for (const p of prs || []) place(p, true);
  for (const p of extra || []) place(p, false);
  return { prs: keep, extra: more };
}

module.exports = { requiredTeamIds, orgTeamsQuery, parseOrgTeams, applyGates };
