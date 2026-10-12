// "When @X is done, do Y": an agent writes a WHEN-DONE marker line, Overlord watches the
// named local agent and, at its next finished turn, injects the task + X's final message
// into the watcher. Pure helpers. Self-check: watch-core.test.js

const MAX_TASK = 4000;
const MAX_LAST = 6000;
const HEADER = '[Overlord watch:';

//   WHEN-DONE @Zephyr: review its diff and open the PR
// Task runs from the colon to the end of the text block (may be multi-line).
const WHEN_DONE_RE = /^\s*WHEN-DONE\s+@?([A-Za-z][A-Za-z0-9]*)\s*:\s*([\s\S]+)/m;
function parseWhenDone(text) {
  const m = String(text || '').match(WHEN_DONE_RE);
  if (!m || !m[2].trim()) return null;
  return { agentName: m[1], task: m[2].trim().slice(0, MAX_TASK) };
}

// A turn that ends on "I AM WORKING" left something running — not done yet, keep watching.
function turnIsDone(lastText) {
  const lines = String(lastText || '').trim().split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  return !lines.some(l => /^I AM WORKING\b/.test(l));
}

function buildWatchMessage(agentName, task, lastText, alreadyIdle) {
  const last = String(lastText || '').trim();
  return `${HEADER} @${agentName} ${alreadyIdle ? 'was already idle when you asked' : 'finished its turn'}]\n`
    + `You asked to do this when it was done:\n${task}\n\n`
    + `@${agentName}'s final message:\n${last ? last.slice(-MAX_LAST) : '(no text)'}`;
}

module.exports = { parseWhenDone, turnIsDone, buildWatchMessage, HEADER };
