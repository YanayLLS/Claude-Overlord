// Filtering for the catalog popover (catalog-core.js builds the list) and the
// ";;" trigger that opens it from the terminal. Pure, so it runs in tests and the page.

// Subsequence match; consecutive letters and word starts score higher. null = no match.
function fuzzyScore(q, s) {
  if (!q) return { score: 0, pos: [] };
  q = q.toLowerCase(); const t = s.toLowerCase();
  const pos = []; let score = 0, j = 0, prev = -2;
  for (let i = 0; i < t.length && j < q.length; i++) {
    if (t[i] !== q[j]) continue;
    score += 1 + (i === prev + 1 ? 5 : 0) + (i === 0 || /[\s\-_:/.]/.test(t[i - 1]) ? 3 : 0);
    pos.push(i); prev = i; j++;
  }
  if (j < q.length) return null;
  return { score: score - (t.length - q.length) * 0.01, pos }; // shorter names win ties
}

const ORIGIN_RANK = { repo: 0, pc: 1, plugin: 2, builtin: 3 };

// type null = every type. Empty query keeps origin order; otherwise best match first.
// A name match always beats a description-only match.
function pickItems(items, type, q) {
  const out = [];
  for (const it of items) {
    if (type && it.type !== type) continue;
    const n = fuzzyScore(q, it.name);
    // ponytail: description needs every word literally — fuzzy over a sentence matches nearly anything
    const d = !n && q && it.desc && q.toLowerCase().split(/\s+/).every(w => it.desc.toLowerCase().includes(w));
    if (!n && !d) continue;
    out.push({ ...it, score: n ? n.score + 1000 : 0, pos: n ? n.pos : [] });
  }
  return out.sort((a, b) => (q ? b.score - a.score : 0) || ORIGIN_RANK[a.origin] - ORIGIN_RANK[b.origin]);
}

// Default hotkey: two quick ";". Rarely typed, unlike "/", which opens Claude's own command menu.
const CATALOG_HOTKEY = ';;';

// Wraps terminal input: the first char of the hotkey sequence (seq(), default ";;") is
// held `ms`; the second one in that window opens the popover and neither reaches the pty.
// Any other data flushes the held char first. A chord hotkey or '' (off) holds nothing.
function makeSlashGate({ send, open, ms = 250, timer = { set: (fn, t) => setTimeout(fn, t), clear: (h) => clearTimeout(h) }, seq = () => CATALOG_HOTKEY }) {
  let held = null, heldCh = '';
  const flush = () => { if (held) { timer.clear(held); held = null; send(heldCh); } };
  return (data) => {
    const sq = seq(), on = sq && parseHotkey(sq)?.seq;
    if (held && on && data === sq[1]) { timer.clear(held); held = null; open(); return; }
    flush();
    if (on && data === sq[0]) { heldCh = data; held = timer.set(() => { held = null; send(heldCh); }, ms); return; }
    send(data);
  };
}

// Hotkey setting: two typed characters ("//", ";;") or a modifier chord ("Ctrl+K").
const KEY_NAMES = { space: ' ' };
function parseHotkey(str) {
  str = String(str || '').trim();
  if (!str) return null;
  const parts = str.split('+').map(p => p.trim().toLowerCase());
  const mods = { ctrl: false, alt: false, shift: false, meta: false };
  if (parts.length > 1) {
    const key = parts.pop();
    for (const m of parts) { if (!(m in mods)) return null; mods[m] = true; }
    if (!mods.ctrl && !mods.alt && !mods.meta) return null; // Shift+x alone is just typing
    return { chord: { ...mods, key: KEY_NAMES[key] ?? key } };
  }
  return [...str].length === 2 ? { seq: str } : null; // ponytail: exactly two chars; one would eat every keystroke
}
function chordMatch(e, hk) {
  const c = hk && hk.chord;
  return !!c && e.ctrlKey === c.ctrl && e.altKey === c.alt && e.shiftKey === c.shift && e.metaKey === c.meta
    && String(e.key).toLowerCase() === c.key;
}
// What the settings recorder writes for a pressed chord, or null (no modifier / modifier alone).
function hotkeyFromEvent(e) {
  if (!(e.ctrlKey || e.altKey || e.metaKey) || /^(Control|Alt|Shift|Meta)$/.test(e.key)) return null;
  const key = e.key === ' ' ? 'Space' : e.key.length === 1 ? e.key.toUpperCase() : e.key;
  return [e.ctrlKey && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift', e.metaKey && 'Meta', key].filter(Boolean).join('+');
}

// The prompt a "+ new" in the picker starts a fresh agent with. null = can't be made (built-ins).
const WHERE = 'this repo (shared with the team) or ~/.claude (all my projects)';
const NEW_ITEM = {
  skill: `I want a new Claude Code skill. Ask me what it should do and whether it belongs in ${WHERE}, then write .claude/skills/<name>/SKILL.md with name and description frontmatter. Use the skill-creator skill if you have it.`,
  command: `I want a new Claude Code slash command. Ask me what it should do and whether it belongs in ${WHERE}, then write .claude/commands/<name>.md with a description (and argument-hint if it takes arguments) in the frontmatter.`,
  agent: `I want a new Claude Code subagent. Ask me what it should be good at and whether it belongs in ${WHERE}, then write .claude/agents/<name>.md with name, description and tools in the frontmatter.`,
  mod: 'I want a new Claude Code mod. Use the plugin-authoring skill. Ask me what it should do before writing anything.',
};
const newItemPrompt = (type) => NEW_ITEM[type] || null;

// Viewport row of the ─── divider on top of Claude's input ("> " / "❯ "), or -1.
// The popover opens above it so the prompt stays visible. Requiring the divider
// keeps a quoted "> " line in the transcript from counting.
function promptTop(lines) {
  for (let i = lines.length - 1; i > 0; i--)
    if (/^\s*(?:>|❯)(\s|$)/.test(lines[i]) && /[─━]{3}/.test(lines[i - 1])) return i - 1;
  return -1;
}

if (typeof module !== 'undefined' && module.exports) module.exports = { CATALOG_HOTKEY, fuzzyScore, pickItems, makeSlashGate, promptTop, parseHotkey, chordMatch, hotkeyFromEvent, newItemPrompt };
