// Prod release sign-off (SOC2: 2 of the approvers team). Pure: who has signed a release PR.
// A signature is either opening the PR (the author, when on the team) or an APPROVED review
// from another team member. Signatures stay valid as the release keeps taking commits (the team's
// choice, 2026-09-30); a later "changes requested" or dismissal still withdraws one.
// Each signature can carry the signer's ClickUp id (Overlord writes it into the PR body / the
// review), so the release ticket can assign them without any account mapping.
// Self-check: signoff-core.test.js

const NEED = 2;
const REVIEW_MARK = '✍ Release signed via Overlord';
const OPENER_RE = /<!-- release-opener:([\w-]+)(?: clickup:(\d+))?(?: sha:([0-9a-f]{7,40}))? -->/;
// the whole opener line, to re-stamp it with a new commit
const OPENER_LINE_RE = /✍ Opened and signed by @[\w-]+ via Overlord <!-- release-opener:[^>]*-->/;
const CLICKUP_RE = /clickup:(\d+)/;

// PR body line for the person opening the release (signature 1). sha = the head commit it covers:
// new commits void it like any other signature (Sign re-stamps it). Marks without a sha predate this.
function openerMark(login, clickupId, sha) {
  return `✍ Opened and signed by @${login} via Overlord <!-- release-opener:${login}${clickupId ? ` clickup:${clickupId}` : ''}${sha ? ` sha:${sha}` : ''} -->`;
}
// Review body for signature 2+
function reviewMark(clickupId) { return REVIEW_MARK + (clickupId ? ` · clickup:${clickupId}` : ''); }

// pr: { user: { login }, body, head: { sha } }; reviews: GitHub review objects; members: logins.
function signoff(pr, reviews, members) {
  const team = new Set((members || []).map(m => String(m).toLowerCase()));
  const author = pr && pr.user && pr.user.login;
  const signers = [], stale = [];
  if (author && team.has(author.toLowerCase())) {
    const m = String((pr && pr.body) || '').match(OPENER_RE);
    const mine = m && m[1].toLowerCase() === author.toLowerCase();
    signers.push({ login: author, via: 'opened', clickup: mine ? m[2] || null : null, sha: (mine && m[3]) || null });
  }
  // each person's latest decisive review wins (a later "changes requested" or dismissal withdraws)
  const latest = new Map();
  for (const r of [...(reviews || [])].sort((a, b) => Date.parse(a.submitted_at) - Date.parse(b.submitted_at))) {
    const who = r.user && r.user.login;
    if (who && ['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(r.state)) latest.set(who.toLowerCase(), r);
  }
  for (const [who, r] of latest) {
    if (r.state !== 'APPROVED' || !team.has(who) || (author && who === author.toLowerCase())) continue;
    // a signature stays valid while the release keeps taking commits (the team's call, 2026-09-30):
    // GitHub still records which commit each approval was on, for the audit
    const m = String(r.body || '').match(CLICKUP_RE);
    signers.push({ login: r.user.login, via: 'approved', clickup: m ? m[1] : null, sha: r.commit_id || null });
  }
  return { signers, stale, count: signers.length, need: NEED, ok: signers.length >= NEED };
}

// A release is signed as ONE thing: someone signed it when they signed every one of its open PRs
// at its current commit (Sign does all of them in one go). prs: [{ label, signoff }].
// gaps: per person who signed some but not all, the PRs still missing them ('older' = new commits since).
function releaseSignoff(prs) {
  const list = (prs || []).filter(p => p.signoff);
  const key = (l) => l.toLowerCase();
  const people = new Map();
  for (const p of list) for (const x of p.signoff.signers.concat((p.signoff.stale || []).map(login => ({ login })))) if (!people.has(key(x.login))) people.set(key(x.login), x.login);
  const signers = [], gaps = [];
  for (const [k, login] of people) {
    const missing = list.filter(p => !p.signoff.signers.some(x => key(x.login) === k))
      .map(p => ({ label: p.label, older: (p.signoff.stale || []).some(l => key(l) === k) }));
    if (!missing.length) signers.push(list[0].signoff.signers.find(x => key(x.login) === k));
    else gaps.push({ login, missing });
  }
  return { signers, gaps, count: signers.length, need: NEED, ok: list.length > 0 && signers.length >= NEED };
}

// Has `login` already signed this PR (opened it, or approved its current head)?
function hasSigned(s, login) { return !!login && s.signers.some(x => x.login.toLowerCase() === login.toLowerCase()); }

module.exports = { NEED, openerMark, reviewMark, signoff, releaseSignoff, hasSigned, OPENER_RE, OPENER_LINE_RE };
