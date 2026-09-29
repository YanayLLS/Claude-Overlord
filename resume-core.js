// Pure helper: does a submitted line switch the agent to another session file?
// Self-check: resume-core.test.js

// Submitted line → 'clear' | 'resume' | null. Picking the command from Claude's
// slash menu submits whatever was typed so far ("/res" + Enter runs /resume), so a
// prefix of 4+ chars counts. ponytail: arrow-picking from a shorter prefix is missed.
function sessionSwitchKind(line) {
  const m = /^\s*(\/[a-z]+)(\s+\S+)?\s*$/.exec(line || '');
  if (!m || m[1].length < 4) return null;
  for (const cmd of ['/clear', '/resume']) if (cmd.startsWith(m[1])) return cmd.slice(1);
  return null;
}

module.exports = { sessionSwitchKind };
