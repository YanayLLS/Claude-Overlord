// Follow the prompt: the transcript an agent really writes to is the one its submitted
// prompt lands in. Covers /resume, /clear, rewind forks, spare adoption, crash respawns —
// every way Claude Code can move a session to another file ends with the next prompt
// being written to the real one. Self-check: follow-core.test.js

const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();

// Submitted line → match key, or null for things that aren't prompts (slash commands, blips).
function promptKey(text) {
  const k = norm(text);
  return k.length >= 3 && !k.startsWith('/') ? k.slice(0, 120) : null;
}

function userText(r) {
  const c = r.message?.content;
  if (typeof c === 'string') return c;
  return Array.isArray(c) ? c.filter(b => b.type === 'text').map(b => b.text || '').join(' ') : '';
}

// A transcript record that carries the submitted prompt (written after `since`).
function recordHasPrompt(r, key, since) {
  if (!r || r.type !== 'user' || !key) return false;
  if (since && Date.parse(r.timestamp) < since - 2000) return false;
  return norm(userText(r)).includes(key);
}

// Tail lines of one JSONL file → true if the prompt landed there.
function linesHavePrompt(lines, key, since) {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes('"user"')) continue;
    try { if (recordHasPrompt(JSON.parse(lines[i]), key, since)) return true; } catch {}
  }
  return false;
}

module.exports = { promptKey, recordHasPrompt, linesHavePrompt };
