// Transcript (.jsonl) lines → the events the Chat view and world mode's Conversation tab draw.
// Pure: main.js passes its tool labeller (fmtTool) and its system-message test.
const TL_TEXT_MAX = 20000, TL_OUT_MAX = 4000, TL_DIFF_MAX = 6000, TL_IMG_MAX = 400000;
const cap = (t, n) => t.length > n ? t.slice(0, n) + '…' : t;

// What the Chat view shows for a call besides fmtTool's label: its target, a command, an edit's before/after.
const ARG_KEYS = ['file_path', 'notebook_path', 'command', 'description', 'pattern', 'path', 'glob', 'url', 'query', 'subagent_type', 'skill'];
function toolArgs(name, inp) {
  const o = {};
  for (const k of ARG_KEYS) if (typeof inp[k] === 'string') o[k] = cap(inp[k], 2000);
  if (name === 'Edit') { o.old = cap(String(inp.old_string || ''), TL_DIFF_MAX); o.new = cap(String(inp.new_string || ''), TL_DIFF_MAX); }
  else if (name === 'MultiEdit' && Array.isArray(inp.edits)) { o.old = cap(inp.edits.map(e => e.old_string || '').join('\n'), TL_DIFF_MAX); o.new = cap(inp.edits.map(e => e.new_string || '').join('\n'), TL_DIFF_MAX); }
  else if (name === 'Write') { o.old = ''; o.new = cap(String(inp.content || ''), TL_DIFF_MAX); }
  else if (name === 'AskUserQuestion' && Array.isArray(inp.questions) && inp.questions[0]) { const q = inp.questions[0]; o.question = cap(String(q.question || ''), 600); o.options = (q.options || []).map(x => ({ label: cap(String(x.label || ''), 200), desc: cap(String(x.description || ''), 300) })); }
  else if (name === 'ExitPlanMode' && typeof inp.plan === 'string') o.plan = cap(inp.plan, TL_TEXT_MAX);
  else if (name === 'Artifact') { for (const k of ['title', 'description', 'action', 'icon']) if (typeof inp[k] === 'string') o[k] = cap(inp[k], 400); }
  else if (name === 'TodoWrite' && Array.isArray(inp.todos)) o.todos = inp.todos.map(t => ({ text: cap(String(t.content || ''), 300), status: t.status }));
  return o;
}

// A user turn: slash commands become one /name line, an interrupt its own marker, pasted images ride along as data URLs.
function promptEvents(ts, blocks, isSystemMessage) {
  const txt = blocks.filter(b => b.type === 'text').map(b => b.text || '').join('').trim();
  const cmd = /^<command-name>\/?([^<]+)<\/command-name>/.exec(txt) || /<command-name>\/?([^<]+)<\/command-name>/.exec(txt);
  if (cmd) { const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(txt); return [{ type: 'command', ts, text: '/' + cmd[1].trim() + (args && args[1].trim() ? ' ' + cap(args[1].trim(), 2000) : '') }]; }
  if (/^\[Request interrupted by user/.test(txt)) return [{ type: 'interrupt', ts }];
  // A background shell or agent finished: the CLI tells the model with a <task-notification>.
  if (/^<task-notification>/.test(txt)) { const id = /<task-id>([^<]+)<\/task-id>/.exec(txt), st = /<status>([^<]+)<\/status>/.exec(txt); return id ? [{ type: 'bgdone', ts, taskId: id[1].trim(), status: st ? st[1].trim() : '' }] : null; }
  if (isSystemMessage(txt)) return null;
  // Claude Code adds an "[Image: source: <path>]" line per pasted image (often as a record of its own). The path is kept:
  // an image too big to embed below still gets its thumbnail from the file.
  const paths = [...txt.matchAll(/\[Image: source: ([^\]]*)\]/g)].map(m => m[1].trim()).filter(Boolean);
  const text = txt.replace(/\[Image: source: [^\]]*\]/g, '').trim();
  if (!text && !blocks.some(b => b.type === 'image')) return paths.length ? [{ type: 'images', ts, paths }] : null;
  const images = blocks.filter(b => b.type === 'image' && b.source && b.source.type === 'base64' && (b.source.data || '').length <= TL_IMG_MAX)
    .map(b => `data:${b.source.media_type || 'image/png'};base64,${b.source.data}`);
  const ev = { type: 'prompt', ts, text: cap(text, TL_TEXT_MAX) };
  if (images.length) ev.images = images;
  if (paths.length) ev.paths = paths;
  return [ev];
}

function parseLineForTimeline(line, fmtTool, isSystemMessage) {
  try {
    const r = JSON.parse(line);
    const ts = r.timestamp || null;
    if (r.type === 'assistant' && Array.isArray(r.message?.content)) {
      // An API failure (rate limit, overload, login) is written as a synthetic assistant message: its own event.
      if (r.isApiErrorMessage) { const t = r.message.content.filter(b => b.type === 'text').map(b => b.text).join('\n'); return [{ type: 'apierror', ts, text: cap(t, 2000), kind: r.error || '' }]; }
      const events = [];
      for (const b of r.message.content) {
        if (b.type === 'text' && b.text) events.push({ type: 'text', ts, text: cap(b.text, TL_TEXT_MAX) });
        if (b.type === 'tool_use' && b.id) { const inp = b.input || {}; events.push({ type: 'tool', ts, name: b.name || 'unknown', text: fmtTool(b.name || '', inp), toolId: b.id, args: toolArgs(b.name, inp) }); }
      }
      // The record's token use rides on its first event, so the Chat view can total a turn's tokens and cost.
      const u = r.message.usage;
      if (events.length && u) events[0].u = { m: r.message.model || '', i: u.input_tokens || 0, o: u.output_tokens || 0, cr: u.cache_read_input_tokens || 0, cw: u.cache_creation_input_tokens || 0 };
      return events.length ? events : null;
    }
    if (r.type === 'user') {
      const c = r.message?.content;
      if (Array.isArray(c)) {
        if (c.some(b => b.type === 'tool_result')) {
          const events = [];
          for (const b of c) {
            if (b.type === 'tool_result' && b.tool_use_id) {
              const out = typeof b.content === 'string' ? b.content : Array.isArray(b.content) ? b.content.filter(x => x.type === 'text').map(x => x.text || '').join('\n') : '';
              const ev = { type: 'tool_done', ts, toolId: b.tool_use_id, text: cap(out, TL_OUT_MAX), err: !!b.is_error };
              // A background shell: its task id and the file its output streams to.
              const bg = /running in background with ID: (\w+)\. Output is being written to: (.+?\.output)/.exec(out);
              if (bg) { ev.bgId = bg[1]; ev.bgOut = bg[2]; }
              const art = /https:\/\/claude\.ai\/[\w/.-]*artifact\/[\w-]+/.exec(out); // a published Artifact's page
              if (art) ev.artifactUrl = art[0];
              const ag = /agentId: (\w+)/.exec(out); // an Agent call's subagent, for its steps
              if (ag) ev.agentId = ag[1];
              events.push(ev);
            }
          }
          return events.length ? events : null;
        }
        return promptEvents(ts, c, isSystemMessage);
      }
      if (typeof c === 'string' && c.trim()) return promptEvents(ts, [{ type: 'text', text: c }], isSystemMessage);
    }
    // A message typed while the agent was working: delivered mid-turn as an attachment, not a user record.
    if (r.type === 'attachment' && r.attachment?.type === 'queued_command' && r.attachment.origin?.kind === 'human' && typeof r.attachment.prompt === 'string') {
      return promptEvents(ts, [{ type: 'text', text: r.attachment.prompt }], isSystemMessage);
    }
    // The CLI's permission mode (bypass / accept edits / plan / ask), for the Chat view's mode chip.
    if (r.type === 'permission-mode' && typeof r.permissionMode === 'string') return [{ type: 'mode', ts, mode: r.permissionMode }];
    if (r.type === 'system' && r.subtype === 'compact_boundary') return [{ type: 'compact', ts }];
    if (r.type === 'system' && r.subtype === 'turn_duration') {
      return [{ type: 'turn', ts, text: `Turn completed (${Math.round((r.durationMs || 0) / 1000)}s)`, ms: r.durationMs || 0 }];
    }
    if (r.type === 'progress' && r.data?.type === 'agent_progress') {
      const msg = r.data.message;
      if (msg?.type === 'assistant' && Array.isArray(msg.message?.content)) {
        for (const b of msg.message.content) {
          if (b.type === 'tool_use') return [{ type: 'subtask', ts, name: b.name, text: fmtTool(b.name || '', b.input || {}) }];
        }
      }
    }
  } catch {}
  return null;
}

module.exports = { parseLineForTimeline, toolArgs };
