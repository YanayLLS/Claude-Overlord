// Pure helper for /resume detection. No fs, no electron — just the pick.
// Self-check: resume-core.test.js
//
// /resume keeps appending to the picked session's own JSONL — Claude Code writes
// no new file (verified on 2.1.218), so the new-file scan that catches /clear is
// blind to it. All we get is "some existing transcript in this project dir came
// back to life after the user hit Enter on /resume", so that's what we match on.

// entries: [{ file, mtimeMs }], since: ms epoch of the /resume, current: the agent's
// file, owned: Set of other agents' files. Newest qualifying file, or null.
function pickResumedFile({ entries, since, current, owned }) {
  let best = null, bestM = since;
  for (const e of entries || []) {
    if (!e || e.file === current || (owned && owned.has(e.file))) continue;
    if (e.mtimeMs > bestM) { best = e.file; bestM = e.mtimeMs; }
  }
  return best;
}

// Submitted line → 'clear' | 'resume' | null. Picking the command from Claude's
// slash menu submits whatever was typed so far ("/res" + Enter runs /resume), so a
// prefix of 4+ chars counts. ponytail: arrow-picking from a shorter prefix is missed.
function sessionSwitchKind(line) {
  const m = /^\s*(\/[a-z]+)(\s+\S+)?\s*$/.exec(line || '');
  if (!m || m[1].length < 4) return null;
  for (const cmd of ['/clear', '/resume']) if (cmd.startsWith(m[1])) return cmd.slice(1);
  return null;
}

module.exports = { pickResumedFile, sessionSwitchKind };
