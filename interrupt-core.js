// Was this agent cut off by an Overlord crash / PC restart? Read from the transcript
// tail: the model's last message didn't end its turn, or background work (shells,
// subagents, teammates) was still running — that work died with the process.
// Self-check: interrupt-core.test.js

const { applyBgRecord } = require('./bg-core');

// ponytail: tail only and a recency cap — tasks launched before the tail are missed, and an
// agent idle for days isn't flagged (an old unsettled task would re-flag on every restart)
const RECENT_MS = 3 * 86400e3;
// Tools that wait on the user: a "continue" nudge would make the agent answer for them.
const ASKS = new Set(['AskUserQuestion', 'ExitPlanMode']);

function interruptedBy(tailText, now = Date.now()) {
  let midTurn = false, asking = false, last = 0;
  const bg = new Set();
  for (const l of tailText.split('\n')) {
    if (!/toolUseResult|task-notification|teammate-message|turn_duration|"type":"assistant"|Request interrupted by user/.test(l)) continue;
    let r; try { r = JSON.parse(l); } catch { continue; } // the tail's first line is cut mid-record
    if (r.type === 'assistant') {
      midTurn = r.message?.stop_reason !== 'end_turn';
      asking = Array.isArray(r.message?.content) && r.message.content.some(b => b.type === 'tool_use' && ASKS.has(b.name));
    }
    else if (r.type === 'user' && JSON.stringify(r.message?.content || '').includes('[Request interrupted by user')) midTurn = false; // stopped with Esc
    else if (r.type === 'system' && r.subtype === 'turn_duration') midTurn = false;
    applyBgRecord(bg, r);
    last = Math.max(last, Date.parse(r.timestamp) || 0);
  }
  if (now - last > RECENT_MS) return null;
  if (midTurn) return asking ? null : 'mid-task';
  return bg.size ? 'background work' : null;
}

module.exports = { interruptedBy };
