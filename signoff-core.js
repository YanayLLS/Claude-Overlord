// Prod release sign-off (SOC2: 2 of the approvers team). Pure: who has signed a release PR.
// A signature is either opening the PR (the author, when on the team) or an APPROVED review
// from another team member on the PR's CURRENT head commit — new commits need new signatures.
// Each signature can carry the signer's ClickUp id (Overlord writes it into the PR body / the
// review), so the release ticket can assign them without any account mapping.
// Self-check: signoff-core.test.js

const NEED = 2;
const REVIEW_MARK = '✍ Release signed via Overlord';
const OPENER_RE = /<!-- release-opener:([\w-]+)(?: clickup:(\d+))? -->/;
const CLICKUP_RE = /clickup:(\d+)/;

// PR body line for the person opening the release (signature 1)
function openerMark(login, clickupId) {
  return `✍ Opened and signed by @${login} via Overlord <!-- release-opener:${login}${clickupId ? ` clickup:${clickupId}` : ''} -->`;
}
// Review body for signature 2+
function reviewMark(clickupId) { return REVIEW_MARK + (clickupId ? ` · clickup:${clickupId}` : ''); }

// pr: { user: { login }, body, head: { sha } }; reviews: GitHub review objects; members: logins.
function signoff(pr, reviews, members) {
  const team = new Set((members || []).map(m => String(m).toLowerCase()));
  const author = pr && pr.user && pr.user.login;
  const head = pr && pr.head && pr.head.sha;
  const signers = [];
  if (author && team.has(author.toLowerCase())) {
    const m = String((pr && pr.body) || '').match(OPENER_RE);
    signers.push({ login: author, via: 'opened', clickup: m && m[1].toLowerCase() === author.toLowerCase() ? m[2] || null : null });
  }
  // each person's latest decisive review wins (a later "changes requested" or dismissal withdraws)
  const latest = new Map();
  for (const r of [...(reviews || [])].sort((a, b) => Date.parse(a.submitted_at) - Date.parse(b.submitted_at))) {
    const who = r.user && r.user.login;
    if (who && ['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(r.state)) latest.set(who.toLowerCase(), r);
  }
  for (const [who, r] of latest) {
    if (r.state !== 'APPROVED' || !team.has(who) || (author && who === author.toLowerCase())) continue;
    if (head && r.commit_id !== head) continue; // signed an older commit: doesn't cover what would merge
    const m = String(r.body || '').match(CLICKUP_RE);
    signers.push({ login: r.user.login, via: 'approved', clickup: m ? m[1] : null });
  }
  return { signers, count: signers.length, need: NEED, ok: signers.length >= NEED };
}

// Has `login` already signed this PR (opened it, or approved its current head)?
function hasSigned(s, login) { return !!login && s.signers.some(x => x.login.toLowerCase() === login.toLowerCase()); }

module.exports = { NEED, openerMark, reviewMark, signoff, hasSigned, OPENER_RE };
