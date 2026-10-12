// @-mentions in the quest reply box: find the query being typed, rank members for it, and turn the box's
// content (text and mention chips) into the blocks ClickUp's comment API takes.
'use strict';

// The mention query at the caret: the text from the last '@' that starts a word up to the caret, or null.
function mentionQuery(textBeforeCaret) {
  const m = /(^|\s)@([^\s@]{0,40})$/.exec(textBeforeCaret || '');
  return m ? { query: m[2], start: textBeforeCaret.length - m[2].length - 1 } : null;
}

// Members matching a query, best first: name starts with it, then any word of the name or the email does.
function rankMembers(members, query, limit = 8) {
  const q = String(query || '').toLowerCase();
  const score = (m) => { const name = String(m.name || '').toLowerCase(), email = String(m.email || '').toLowerCase(); if (!q) return 1; if (name.startsWith(q)) return 3; if (name.split(/\s+/).some(w => w.startsWith(q))) return 2; if (name.includes(q) || email.startsWith(q)) return 1; return 0; };
  return (members || []).map(m => [score(m), m]).filter(([s]) => s > 0).sort((a, b) => b[0] - a[0] || String(a[1].name).localeCompare(String(b[1].name))).slice(0, limit).map(([, m]) => m);
}

// Comment blocks from the box's parts: runs of text and mention chips. Adjacent text runs merge; a mention is a
// ClickUp tag block carrying the user's id. Also returns the plain text for the fallback and the preview.
function toBlocks(parts) {
  const blocks = []; let text = '';
  for (const p of parts || []) {
    if (p.tag != null) { const label = '@' + (p.name || 'someone'); blocks.push({ type: 'tag', user: { id: Number(p.tag) || String(p.tag) } }); text += label; }
    else if (p.text) { const last = blocks[blocks.length - 1]; if (last && last.text != null && last.type == null) last.text += p.text; else blocks.push({ text: p.text, attributes: {} }); text += p.text; }
  }
  // trim outer whitespace but keep inner structure
  while (blocks.length && blocks[0].text != null && !blocks[0].text.trim()) blocks.shift();
  while (blocks.length && blocks[blocks.length - 1].text != null && !blocks[blocks.length - 1].text.trim()) blocks.pop();
  if (blocks.length && blocks[0].text != null) blocks[0].text = blocks[0].text.replace(/^\s+/, '');
  if (blocks.length && blocks[blocks.length - 1].text != null) blocks[blocks.length - 1].text = blocks[blocks.length - 1].text.replace(/\s+$/, '');
  return { blocks, text: text.trim(), hasMention: blocks.some(b => b.type === 'tag') };
}

// Members as the API lists them, in the shape the picker shows.
function normalizeMembers(team) {
  const out = [];
  for (const m of (team && team.members) || []) { const u = m && m.user; if (!u || u.id == null) continue; out.push({ id: String(u.id), name: u.username || u.email || ('user ' + u.id), email: u.email || '', color: u.color || '', pic: u.profilePicture || '', initials: u.initials || String(u.username || '?').slice(0, 2).toUpperCase() }); }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// @AgentName runs in a terminal line, for known agent names only (case-insensitive): [{ start, len }].
function agentMentions(line, names) {
  const set = new Set((names || []).map(n => String(n).toLowerCase()));
  const out = [];
  for (const m of String(line || '').matchAll(/(^|[^\w@])@([A-Za-z][A-Za-z0-9]*)/g)) {
    if (set.has(m[2].toLowerCase())) out.push({ start: m.index + m[1].length, len: m[2].length + 1 });
  }
  return out;
}

// A prompt that STARTS with @Name(s) is addressed to those agents: "@Pike @Rio why is it empty?" →
// { names: ['Pike', 'Rio'], unknown: [], body: 'why is it empty?' }. Null when it doesn't start with a known agent
// or there is nothing to send. A @Name mid-sentence is not addressing anyone (context for this agent instead).
function leadingAgentMentions(text, names) {
  const m = /^\s*((?:@[A-Za-z][A-Za-z0-9]*[\s,]*)+)([\s\S]*)$/.exec(String(text || ''));
  if (!m) return null;
  const byLower = new Map((names || []).map(n => [String(n).toLowerCase(), n]));
  const found = [], unknown = [];
  for (const [, n] of m[1].matchAll(/@([A-Za-z][A-Za-z0-9]*)/g)) {
    const real = byLower.get(n.toLowerCase());
    if (!real) unknown.push(n); else if (!found.includes(real)) found.push(real);
  }
  const body = m[2].trim();
  return found.length && body ? { names: found, unknown, body } : null;
}

if (typeof module !== 'undefined') module.exports = { mentionQuery, rankMembers, toBlocks, normalizeMembers, agentMentions, leadingAgentMentions };
if (typeof window !== 'undefined') window.mentionCore = { mentionQuery, rankMembers, toBlocks, normalizeMembers, agentMentions, leadingAgentMentions };
