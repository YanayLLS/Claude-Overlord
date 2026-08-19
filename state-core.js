// Pure parser for the saved state blob. No fs, no electron — just the decode.
// Self-check: state-core.test.js
//
// A hard power-off can leave overlord-state.json truncated or zero-filled (NTFS
// keeps the rename but loses the data). Returning an empty state for that case
// looked identical to "first launch", so the next save wrote the empty list over
// the user's agents, bookmarks and PR settings for good. null means "unusable —
// go read the backup", which is a different thing from "no agents yet".

function parseState(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  let data;
  try { data = JSON.parse(raw); } catch { return null; }
  if (Array.isArray(data)) return { agents: data, settings: {} }; // old format (plain array)
  if (!data || typeof data !== 'object') return null;
  if (!('agents' in data) && !('settings' in data)) return null; // some other JSON, not ours
  return {
    agents: Array.isArray(data.agents) ? data.agents : [],
    settings: (data.settings && typeof data.settings === 'object') ? data.settings : {},
  };
}

module.exports = { parseState };
