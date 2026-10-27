// Chat view: the agent's transcript drawn like Claude's desktop app. Replies in markdown, your prompts as bubbles,
// each run of tool calls folded into one line ("Ran 2 commands, read 3 files") that opens to the calls, and each call
// to its command + output or its diff. Fed by the timeline events (timeline-core.js); index.html's renderConversation
// hands over the agent and its status, this file draws the thread, the live tail (working line, plan, background
// agents, permission/question cards) and the composer's chips (mode, model, context).
(function () {
  const escH = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const svg = (d, cls = 'ic') => `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`;
  const ICON = {
    cmd: svg('<path d="m4 17 6-5-6-5"/><path d="M12 19h8"/>'),
    read: svg('<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/>'),
    edit: svg('<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>'),
    search: svg('<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/>'),
    web: svg('<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a14 14 0 0 1 0 18 14 14 0 0 1 0-18"/>'),
    agent: svg('<rect x="4" y="8" width="16" height="12" rx="3"/><path d="M12 4v4"/><circle cx="9" cy="14" r="1"/><circle cx="15" cy="14" r="1"/>'),
    todo: svg('<path d="m4 7 2 2 4-4"/><path d="M13 7h7"/><path d="m4 17 2 2 4-4"/><path d="M13 17h7"/>'),
    tool: svg('<path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.5 2.5-2.4-.6-.6-2.4z"/>'),
    ask: svg('<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6v.6"/><path d="M12 17h.01"/>'),
    plan: svg('<path d="M9 5h11M9 12h11M9 19h11"/><path d="M4 5h.01M4 12h.01M4 19h.01"/>'),
    chev: svg('<path d="m9 6 6 6-6 6"/>', 'ic chev'),
    copy: svg('<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>'),
    check: svg('<path d="m5 12 5 5 9-10"/>'),
    shield: svg('<path d="M12 3 5 6v6c0 4.5 3 7.5 7 9 4-1.5 7-4.5 7-9V6z"/>'),
    retry: svg('<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>'),
    alert: svg('<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/>'),
  };
  // Claude's spark: turning while the agent works, popping once when a turn lands.
  const SPARK = '<svg class="spark" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.5l1.6 6.2 5.6-3.2-3.2 5.6 6.2 1.6-6.2 1.6 3.2 5.6-5.6-3.2L12 21.5l-1.6-6.2-5.6 3.2 3.2-5.6L1.8 12l6.2-1.6-3.2-5.6 5.6 3.2z"/></svg>';
  const MODES = { bypassPermissions: ['Bypass permissions', 'bypass', 'Bypass'], acceptEdits: ['Accept edits', 'accept', 'Edits'], plan: ['Plan mode', 'plan', 'Plan'], auto: ['Auto mode', 'auto', 'Auto'], default: ['Ask first', 'ask', 'Ask'] };

  // Events never change once received, so each renders once; tool rows again when their result lands.
  // The text cache is dropped when md-bundle arrives (replies first render as plain text).
  const toolCache = new WeakMap();
  let cache = new WeakMap(), mdReady = !!window.marked, mdLoading = false, rerender = () => {};
  function md(src, cwd) {
    if (!mdReady) {
      if (!mdLoading) mdLoading = true, window.docsUi.loadMd().then(() => { mdReady = true; cache = new WeakMap(); rerender(); }, () => {});
      return `<p class="plain">${escH(src)}</p>`;
    }
    return window.docsUi.toHtml(src, (cwd || '').replace(/\\/g, '/') + '/_'); // relative links resolve against the agent's folder
  }
  const fileUrl = (p) => 'file:///' + encodeURI(String(p).replace(/\\/g, '/').replace(/^\/+/, '')).replace(/#/g, '%23');
  // A prompt's images, numbered 1, 2, … in order, and its [Image #N] tags as chips with the same numbers (the k-th tag
  // is the k-th image), so "compare [Image #1] with [Image #2]" reads against the thumbnails above it.
  // The CLI numbers images across the whole session, so a later prompt can say "[Image #12]" about an earlier one:
  // tagSrc maps each number to its picture (filled in thread order), and a chip shows a small preview that opens it.
  const tagSrc = new Map();
  const tagNums = (text) => [...String(text || '').matchAll(/\[Image #(\d+)\]/g)].map(m => m[1]);
  const thumbs = (srcs, nums = []) => srcs.length ? `<div class="imgs">${srcs.map((s, k) => `<span class="th"><img src="${escH(s)}" alt="" loading="lazy"><b>${escH(nums[k] || k + 1)}</b></span>`).join('')}</div>` : '';
  const promptSrcs = (ev) => (ev.images && ev.images.length ? ev.images : (ev.paths || []).map(fileUrl));
  // own: the prompt's own number → picture map (a not-yet-sent prompt numbers its images itself)
  const tagChips = (text, own) => escH(text).replace(/\[Image #(\d+)\]/g, (_, n) => { const s = (own && own.get(n)) || tagSrc.get(n); return s ? `<button type="button" class="imgtag" data-src="${escH(s)}" title="Image #${n}"><img src="${escH(s)}" alt="">#${n}</button>` : `<span class="imgtag">${svg('<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="10" r="1.5"/><path d="m21 16-5-5-9 8"/>')}#${n}</span>`; });
  const dur = (ms) => { const s = Math.round(ms / 1000); return s < 60 ? s + 's' : s < 3600 ? Math.floor(s / 60) + 'm ' + (s % 60) + 's' : Math.floor(s / 3600) + 'h ' + Math.floor(s % 3600 / 60) + 'm'; };
  const clock = (ts) => { try { return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); } catch { return ''; } };

  function diffHtml(old, neu) {
    const d = lineDiff(old, neu);
    const rows = d.rows.map(r => r.t === '…' ? '<div class="dl fold"><i></i><span>⋯</span></div>' : `<div class="dl ${r.t === '+' ? 'add' : r.t === '-' ? 'del' : ''}"><i>${r.t === ' ' ? '' : r.t}</i><span>${escH(r.s) || ' '}</span></div>`).join('');
    return { html: `<div class="diff">${rows}</div>`, add: d.add, del: d.del };
  }
  function todoHtml(todos) {
    return '<ul class="todos">' + todos.map(t => `<li class="${escH(t.status)}">${t.status === 'completed' ? ICON.check : '<span class="box"></span>'}<span>${escH(t.text)}</span></li>`).join('') + '</ul>';
  }
  // One call: icon · verb · target · (+add −del) · chevron, opening to its command/output, diff, plan or answer.
  function toolRow(ev, done, cwd) {
    const c = toolCache.get(ev); if (c && c[0] === done) return c[1];
    const running = !done && !!ev.toolId, a = ev.args || {}, v = toolView(ev, running), err = !!(done && done.err);
    const out = done && done.text ? done.text.replace(/\s+$/, '') : '';
    let body = '', stat = '';
    if (a.old != null || a.new != null) { const d = diffHtml(a.old, a.new); body = d.html; stat = `<span class="stat"><b class="add">+${d.add}</b> <b class="del">−${d.del}</b></span>`; if (err && out) body += `<pre class="out">${escH(out)}</pre>`; }
    else if (a.todos) body = `<div class="plan-card past">${todoHtml(a.todos)}</div>`; // the live plan card's frame, without its bar
    else if (a.plan) body = `<div class="md sub plan">${md(a.plan.replace(/^#{1,6}\s*plan\s*\n+/i, ''), cwd)}</div>`;
    else if (v.kind === 'ask') body = (a.options || []).length ? '<ul class="opts">' + a.options.map(o => `<li>${escH(o.label ?? o)}</li>`).join('') + '</ul>' + (out && !err ? `<div class="answer">${escH(out)}</div>` : '') : '';
    else if (v.kind === 'cmd') body = `<div class="io${err ? ' err' : ''}"><div class="io-r"><span class="lbl">IN</span><pre>${escH(a.command || '')}</pre></div>${out ? `<div class="io-r"><span class="lbl">OUT</span><pre>${escH(out)}</pre></div>` : ''}</div>`;
    else if (v.kind === 'agent' && out) body = `<div class="md sub">${md(out, cwd)}</div>`;
    else if (out) body = `<pre class="out${err ? ' err' : ''}">${escH(out)}</pre>`;
    const cls = `trow k-${v.kind}${running ? ' running' : ''}${err ? ' err' : ''}${ev.type === 'subtask' ? ' sub' : ''}`;
    const head = `${ICON[v.kind] || ICON.tool}<span class="verb">${escH(v.verb)}</span>${v.target ? `<span class="tgt${v.mono ? ' mono' : ''}" title="${escH(v.target)}">${escH(v.target)}</span>` : ''}${stat}${running && ev.ts ? `<span class="el" data-t="${Date.parse(ev.ts)}"></span>` : ''}`;
    const h = body ? `<details class="${cls}" data-tid="${escH(ev.toolId || '')}"><summary>${head}${ICON.chev}</summary><div class="tbody">${body}</div></details>` : `<div class="${cls}"><div class="sumrow">${head}</div></div>`;
    toolCache.set(ev, [done, h]);
    return h;
  }
  // A run of calls between two messages: one call shows as itself; more fold into one summary line.
  function groupHtml(tools, doneBy, cwd) {
    const rows = tools.map(ev => toolRow(ev, doneBy.get(ev.toolId), cwd));
    if (tools.length === 1) return `<div class="tools">${rows[0]}</div>`;
    const errs = tools.filter(ev => (doneBy.get(ev.toolId) || {}).err).length;
    // While a call runs the line names it ("Running npm test"), with a dot; once all are done, the summary.
    const live = [...tools].reverse().find(ev => ev.toolId && !doneBy.get(ev.toolId)), lv = live && toolView(live, true);
    const label = lv ? `${escH(lv.verb)}${lv.target ? ` <span class="mono">${escH(lv.target)}</span>` : ''}` : escH(groupSummary(tools));
    return `<div class="tools"><details class="tgroup${live ? ' running' : ''}" data-tid="g:${escH(tools[0].toolId || '')}"><summary>${live ? '<span class="dot"></span>' : ''}<span class="gl">${label}</span><span class="gl gs">${tools.length} actions</span>${errs ? `<span class="errs">${errs} failed</span>` : ''}${ICON.chev}</summary><div class="tlist">${rows.join('')}</div></details></div>`;
  }

  function msgHtml(ev, i, cwd) {
    let h = cache.get(ev); if (h != null) return h;
    if (ev.type === 'images') h = `<div class="msg user imgs-only"><div class="imgs">${ev.paths.map(p => `<img src="${escH(fileUrl(p))}" alt="" loading="lazy">`).join('')}</div></div>`;
    else if (ev.type === 'prompt') {
      // Embedded images first; an image too big to embed shows from its file, via the path Claude Code wrote.
      const srcs = promptSrcs(ev);
      const text = (ev.text || '').trim(), nums = tagNums(text);
      const imgs = thumbs(srcs, nums);
      const long = text.length > 900 || text.split('\n').length > 14;
      h = `<div class="msg user" data-i="${i}">${imgs ? `<div class="imgs">${imgs}</div>` : ''}${text ? `<div class="bubble${long ? ' long' : ''}">${tagChips(text)}</div>${long ? '<button class="more" type="button">Show more</button>' : ''}` : ''}</div>`;
    } else if (ev.type === 'text') h = `<div class="msg ai" data-i="${i}"><div class="md">${md(ev.text, cwd)}</div></div>`;
    else if (ev.type === 'command') h = `<div class="msg cmd" data-i="${i}"><span>${escH(ev.text)}</span></div>`;
    else if (ev.type === 'interrupt') h = '<div class="msg note">⎿ Interrupted</div>';
    else if (ev.type === 'compact') h = '<div class="msg divider"><span>Conversation compacted</span></div>';
    else if (ev.type === 'apierror') { // rate limit, overload, login trouble: a card that says so, with Retry
      const limit = /limit|rate/i.test(ev.kind + ' ' + ev.text);
      h = `<div class="msg apierr" data-i="${i}"><div class="card err">${'<div class="card-h">' + ICON.alert}<span>${limit ? 'Usage limit reached' : 'Request failed'}</span></div><p>${escH(ev.text)}</p><div class="btns"><button type="button" data-act="retry">Retry</button></div></div></div>`;
    }
    else h = '';
    if (mdReady || ev.type !== 'text') cache.set(ev, h);
    return h;
  }
  // Under a finished turn: copy its last reply · how long it worked · when it finished — the CLI's "Cogitated for 42s".
  // Also what the turn changed ("3 files · +42 −10", click opens those edits) and what it cost ("$0.42 · ↓ 18k").
  const famOf = (m) => /opus/i.test(m) ? 'opus' : /haiku/i.test(m) ? 'haiku' : /fable|mythos/i.test(m) ? 'fable' : 'sonnet';
  const diffCache = new WeakMap();
  const editStat = (ev) => { let d = diffCache.get(ev); if (!d) { d = lineDiff(ev.args.old, ev.args.new); diffCache.set(ev, d); } return d; };
  function footHtml(textAt, turn, sum) {
    const meta = turn ? `<span class="tf-meta">${SPARK}Worked ${escH(dur(turn.ms))}${turn.ts ? ' · ' + escH(clock(turn.ts)) : ''}</span>` : '';
    let files = '', cost = '';
    if (sum && sum.files.size) files = `<button type="button" class="tf-files" data-act="turn-edits" data-from="${sum.from}" data-to="${sum.to}" title="Show this turn's edits">${ICON.edit}${sum.files.size} file${sum.files.size > 1 ? 's' : ''} <b class="add">+${sum.add}</b> <b class="del">−${sum.del}</b></button>`;
    if (sum && sum.o && typeof calcCost === 'function') { const c = calcCost({ modelFamily: famOf(sum.m), inTok: sum.i + sum.cr + sum.cw, outTok: sum.o, cacheTok: sum.cw, cacheRead: sum.cr }); cost = `<span class="tf-cost" title="This turn's cost and tokens written">${escH(fmtCost(c))} · ↓ ${escH(sum.o >= 1000 ? (sum.o / 1000).toFixed(1) + 'k' : String(sum.o))}</span>`; }
    return `<div class="turnfoot"${textAt >= 0 ? ` data-i="${textAt}"` : ''}>${textAt >= 0 ? `<button class="act copy" type="button" title="Copy reply" aria-label="Copy reply">${ICON.copy}</button>` : ''}${meta}${cost}${files}</div>`;
  }

  // The transcript as blocks (one per message, tool run or turn footer), so paint can swap only what changed.
  // A turn's footer waits until the turn is over: its turn_duration line, or the next prompt.
  function blocks(evs, doneBy, cwd) {
    const out = []; let run = [], textAt = -1, turn = null, open = false, lastPrompt = null, lastPromptAt = -1;
    const fresh = () => ({ files: new Set(), add: 0, del: 0, i: 0, o: 0, cr: 0, cw: 0, m: '', from: -1, to: -1 });
    let sum = fresh();
    const tally = (ev, i) => {
      if (ev.u) { sum.i += ev.u.i; sum.o += ev.u.o; sum.cr += ev.u.cr; sum.cw += ev.u.cw; if (ev.u.m && ev.u.m !== '<synthetic>') sum.m = ev.u.m; }
      if (ev.type === 'tool' && ev.args && (ev.args.old != null || ev.args.new != null) && doneBy.get(ev.toolId) && !doneBy.get(ev.toolId).err) {
        const d = editStat(ev); sum.files.add(ev.args.file_path || ev.args.notebook_path || '?'); sum.add += d.add; sum.del += d.del;
        if (sum.from < 0) sum.from = i; sum.to = i;
      }
    };
    for (let k = evs.length - 1; k >= 0; k--) if (evs[k].type === 'prompt') { lastPromptAt = k; break; }
    // This agent's image numbers → pictures, so a later [Image #N] can show the image it means.
    tagSrc.clear(); for (const ev of evs) if (ev.type === 'prompt') { const ns = tagNums(ev.text); promptSrcs(ev).forEach((src, k) => { if (ns[k]) tagSrc.set(ns[k], src); }); }
    const flush = () => { if (run.length) out.push(groupHtml(run, doneBy, cwd)); run = []; };
    // Only a finished turn gets a footer: a message typed mid-turn doesn't end the turn.
    const close = () => { flush(); if (open && turn) out.push(footHtml(textAt, turn, sum)); textAt = -1; turn = null; open = false; sum = fresh(); };
    evs.forEach((ev, i) => {
      const t = ev.type;
      tally(ev, i);
      if (t === 'tool' && (ev.name === 'AskUserQuestion' || ev.name === 'ExitPlanMode') && !doneBy.get(ev.toolId)) return; // its card shows it
      if (t === 'tool' || t === 'subtask') { run.push(ev); open = true; return; }
      if (t === 'tool_done' || t === 'mode' || t === 'bgdone') return;
      // The "[Image: source: …]" record after a prompt: only shown when that prompt had no thumbnails of its own.
      if (t === 'images') { if (lastPrompt && ((lastPrompt.images || []).length || (lastPrompt.paths || []).length)) return; }
      if (t === 'prompt') lastPrompt = ev;
      if (t === 'turn') { turn = ev; return; }
      if (t === 'prompt' || t === 'command') close();
      flush(); out.push(msgHtml(ev, i, cwd));
      if (t === 'text') { textAt = i; open = true; }
      // Your last prompt: Edit puts it back in the box, Retry sends it again.
      if (i === lastPromptAt && ev.text) out.push(`<div class="uacts" data-i="${i}"><button type="button" class="act" data-act="edit-prompt" title="Edit">${ICON.edit}</button><button type="button" class="act" data-act="retry" title="Send again">${ICON.retry}</button></div>`);
    });
    flush(); if (turn) close();
    for (let k = out.length - 1; k >= 0; k--) if (out[k].startsWith('<div class="turnfoot"')) { out[k] = out[k].replace('<div class="turnfoot"', '<div class="turnfoot latest"'); break; }
    return out;
  }

  // ── Live tail: what the CLI shows under the transcript ──
  const lastTool = (evs, name, doneBy) => { for (let k = evs.length - 1; k >= 0; k--) { const e = evs[k]; if (e.type === 'tool' && e.name === name) return doneBy && doneBy.get(e.toolId) ? null : e; if (e.type === 'prompt') return null; } return null; };
  // What's being approved, as the terminal shows it: an edit's diff, a command in full, a new file's content.
  function permHtml(perm, evs, doneBy) {
    const n = perm.name || '', title = n === 'Bash' || n === 'PowerShell' ? 'Run this command?' : /^(Edit|Write|MultiEdit|NotebookEdit)$/.test(n) ? 'Make this edit?' : /^Web/.test(n) ? 'Fetch this page?' : `Allow ${escH(n.replace(/^mcp__[^_]+__/, '')) || 'this action'}?`;
    const kind = toolView({ name: n }).kind, ev = lastTool(evs, n, doneBy), a = (ev && ev.args) || {};
    let what = `<pre>${escH(perm.status || n)}</pre>`;
    if (a.old != null || a.new != null) what = `<div class="perm-file">${ICON.edit}<span class="mono">${escH(a.file_path || '')}</span></div>${diffHtml(a.old, a.new).html}`;
    else if (a.command) what = `<pre>${escH(a.command)}</pre>${a.description ? `<p class="perm-desc">${escH(a.description)}</p>` : ''}`;
    else if (a.url || a.query) what = `<pre>${escH(a.url || a.query)}</pre>`;
    return `<div class="card perm"><div class="card-h">${ICON[kind] || ICON.shield}<span>${title}</span></div>${what}<div class="btns"><button class="primary" type="button" data-keys="1">Allow once<kbd>1</kbd></button><button type="button" data-keys="2">Always allow<kbd>2</kbd></button><button type="button" data-keys="esc">Deny<kbd>Esc</kbd></button></div></div>`;
  }
  // The terminal's open menu ("❯ 1. Yes …  2. No …"), read off its last lines: the plan card's choices are exactly
  // the CLI's, whatever this version offers.
  function menuOptions(id) {
    const x = typeof xterms !== 'undefined' && xterms.get(id), b = x && x.terminal && x.terminal.buffer.active; if (!b) return [];
    const out = [];
    for (let i = Math.max(0, b.length - 30); i < b.length; i++) { const m = /^\s*[❯›>]?\s*(\d)\.\s+(.+?)\s*$/.exec(b.getLine(i)?.translateToString() || ''); if (m) out[+m[1] - 1] = m[2]; }
    return out.filter(Boolean);
  }
  // A proposed plan waiting for approval: the plan itself, rendered, and the CLI's own choices as buttons.
  function planHtml(ev, cwd) {
    const opts = menuOptions(selectedId), labels = opts.length ? opts : ['Yes, and auto-accept edits', 'Yes, and manually approve edits', 'No, keep planning'];
    return `<div class="card ask plan-ask"><div class="card-h">${ICON.plan}<span>Ready to code? Here's the plan</span></div><div class="md sub plan">${md(String(ev.args.plan || '').replace(/^#{1,6}\s*plan\s*\n+/i, ''), cwd)}</div><div class="choices">${labels.map((l, k) => `<button type="button" data-pick="${k}"><kbd>${k + 1}</kbd><span class="ch-t"><b>${escH(l)}</b></span></button>`).join('')}</div></div>`;
  }
  function askHtml(ask, perm) {
    const a = (ask && ask.args) || {}, opts = a.options || [];
    const q = a.question || (perm && perm.status) || 'Claude has a question';
    return `<div class="card ask"><div class="card-h">${ICON.ask}<span>${escH(q)}</span></div><div class="choices">${opts.map((o, k) => `<button type="button" data-pick="${k}"><kbd>${k + 1}</kbd><span class="ch-t"><b>${escH(o.label ?? o)}</b>${o.desc ? `<small>${escH(o.desc)}</small>` : ''}</span></button>`).join('')}<button type="button" class="other" data-act="answer"><kbd>${opts.length + 1}</kbd><span>${opts.length ? 'Something else' : 'Answer in terminal'}</span></button></div></div>`;
  }
  function liveHtml(a, st, evs, doneBy, now) {
    const live = [...a.tools.values()].filter(t => !t.done), perm = live.find(t => t.perm);
    let h = '';
    // The plan: the latest todo list while any of it is open, like the CLI's checklist under the spinner.
    const todo = (() => { for (let k = evs.length - 1; k >= 0; k--) { const e = evs[k]; if (e.type === 'tool' && e.name === 'TodoWrite') return e.args && e.args.todos; if (e.type === 'prompt') return null; } return null; })();
    const busy = st === 'active' || st === 'resuming' || st === 'permission' || st === 'question';
    if (busy && todo && todo.some(t => t.status !== 'completed')) {
      const done = todo.filter(t => t.status === 'completed').length;
      h += `<div class="plan-card"><div class="pc-h">${ICON.todo}<span>Plan</span><span class="pc-n">${done}/${todo.length}</span><span class="pc-bar"><i style="width:${Math.round(done / todo.length * 100)}%"></i></span></div>${todoHtml(todo)}</div>`;
    }
    // Background agents still running: an Agent call without a result, or one launched in the background whose
    // task-notification hasn't come yet.
    const ended = new Set(evs.filter(e => e.type === 'bgdone').map(e => e.taskId));
    const bg = evs.filter(e => { if (e.type !== 'tool' || (e.name !== 'Agent' && e.name !== 'Task')) return false; const d = doneBy.get(e.toolId); return !d || (d.agentId && /background|launched/i.test(d.text) && !ended.has(d.agentId)); });
    // Background shells (Bash run_in_background) until their task-notification: a chip each, opening to the live output.
    const shells = evs.filter(e => e.type === 'tool' && doneBy.get(e.toolId) && doneBy.get(e.toolId).bgId && !ended.has(doneBy.get(e.toolId).bgId));
    if (shells.length) h += `<div class="bg-agents">${shells.map(e => { const d = doneBy.get(e.toolId); return `<button type="button" class="bga bgsh" data-bgout="${escH(d.bgOut)}" data-bgname="${escH((e.args && (e.args.description || e.args.command)) || 'Background shell')}" title="Show its output">${ICON.cmd}<span class="bga-n">${escH((e.args && (e.args.description || e.args.command)) || 'Background shell')}</span><span class="bga-t" data-live="s${escH(e.toolId)}">${e.ts ? escH(dur(now - Date.parse(e.ts))) : ''}</span><span class="bga-dot"></span></button>`; }).join('')}</div>`;
    if (bg.length) h += `<div class="bg-agents">${bg.map(e => `<button type="button" class="bga" data-jump="${escH(e.toolId)}" title="Show this agent's call">${ICON.agent}<span class="bga-n">${escH((e.args && (e.args.description || e.args.subagent_type)) || 'Agent')}</span><span class="bga-t" data-live="b${escH(e.toolId)}">${e.ts ? escH(dur(now - Date.parse(e.ts))) : ''}</span><span class="bga-dot"></span></button>`).join('')}</div>`;
    if (perm && perm.perm === 'ask') { const plan = lastTool(evs, 'ExitPlanMode', doneBy); return h + (plan && plan.args && plan.args.plan ? planHtml(plan, a.cwd) : askHtml(lastTool(evs, 'AskUserQuestion', doneBy), perm)); }
    if (perm) return h + permHtml(perm, evs, doneBy);
    if (a.crashed === 'fatal') return h + `<div class="card err"><div class="card-h">${ICON.alert}<span>The agent stopped</span></div><p>Process exited after ${a.crashCount}/${a.crashMax} attempts.</p><div class="btns"><button class="primary" type="button" data-act="resume">Resume</button></div></div>`;
    if (a.compacting) return h + `<div class="working">${SPARK}<span class="shimmer">Compacting conversation…</span></div>`;
    if (st === 'active' || st === 'resuming') {
      // The CLI's own playful verb ("Cogitating…") when it has one; the call in flight under it; elapsed; the Esc hint.
      const tool = (() => { for (let k = evs.length - 1; k >= 0; k--) { const e = evs[k]; if ((e.type === 'tool') && e.toolId && !doneBy.get(e.toolId) && e.name !== 'Agent' && e.name !== 'Task') return e; if (e.type === 'prompt') return null; } return null; })();
      const v = tool ? toolView(tool, true) : null;
      // Elapsed and tokens written this turn, like the CLI's "(1m 4s · ↓ 3.2k tokens · esc to interrupt)".
      const tok = a.stats && a._tok0 != null ? (a.stats.outTok || 0) - a._tok0 : 0;
      const meta = [a.activeAt ? dur(now - a.activeAt) : '', tok > 0 ? '↓ ' + (tok >= 1000 ? (tok / 1000).toFixed(1) + 'k' : tok) + ' tokens' : ''].filter(Boolean).map(escH).join(' · ');
      return h + `<div class="working">${SPARK}<span class="shimmer" data-live="v">${escH(a.spinnerText || (bg.length ? `Waiting for ${bg.length} background agent${bg.length > 1 ? 's' : ''}…` : 'Thinking…'))}</span>${v ? `<span class="w-tool">${escH(v.verb)} <span class="mono">${escH(v.target)}</span></span>` : ''}<span class="w-hint"><span data-live="m">${meta}</span>${meta ? ' · ' : ''}<kbd>Esc</kbd><span class="w-x"> to interrupt</span></span></div>`;
    }
    return h;
  }

  // A prompt sent from the composer shows at once, dimmed, until the transcript writes it (or the agent queues it).
  // It matches the transcript's prompt with the [Image #N] tags Claude adds for its images taken out.
  // Several can wait at once (each prompt you send while the agent works); each queued one has ✕ to take it back.
  const pending = new Map(); // agent id → [{ text, imgs, at, held, busyAt }]
  const norm = (s) => String(s || '').replace(/\[Image #\d+\]/g, ' ').replace(/\s+/g, ' ').trim();
  function pendingHtml(id, evs, busy) {
    const list = pending.get(id); if (!list || !list.length) return '';
    // A prompt sent while the agent works can wait in the CLI's queue until the turn ends, so it only expires once the
    // agent has been idle a while without it showing up.
    for (const p of [...list]) {
      if (busy) p.busyAt = Date.now();
      if (evs.some(e => e.type === 'prompt' && e.ts && Date.parse(e.ts) >= p.at - 2000 && norm(e.text) === norm(p.text)) || (!busy && Date.now() - (p.busyAt || p.at) > 120000)) list.splice(list.indexOf(p), 1);
    }
    return list.map((p, k) => {
      const imgs = thumbs(p.imgs, tagNums(p.text));
      const queued = busy && !p.held;
      return `<div class="msg user pending">${imgs}${p.text ? `<div class="bubble">${tagChips(p.text, new Map(tagNums(p.text).map((n, j) => [n, p.imgs[j]]).filter(e => e[1])))}</div>` : ''}<span class="q">${p.held ? 'Attaching…' : queued ? 'Queued' : 'Sending…'}${queued && p.text ? `<button type="button" class="q-x" data-unqueue="${k}" title="Take back (the agent keeps working)">Cancel</button>` : ''}</span></div>`;
    }).join('');
  }
  // Take a queued prompt back without stopping the agent. The CLI has no "remove from queue": ↑ in its empty prompt pulls
  // the queued messages into the input; if that's what came up, Ctrl+C on the (non-empty) input clears it — it only
  // interrupts on an empty input, which is checked first — and the others still wanted are queued again.
  async function unqueue(id, k) {
    const list = pending.get(id) || [], p = list[k]; if (!p) return;
    const x = typeof xterms !== 'undefined' && xterms.get(id), t = x && x.terminal;
    const box = () => (t && typeof readPromptBox === 'function' ? norm(readPromptBox(t)) : null);
    const wait = (ms) => new Promise(r => setTimeout(r, ms));
    if (box() == null) return showToast('Open the agent once in Terminal, then cancel again');
    if (box()) return showToast("The agent's prompt has text in it; cancel from the terminal");
    api.send({ type: 'termInput', id, data: '\x1b[A' }); await wait(350);
    const got = box();
    if (!got) return showToast('Already delivered to the agent');
    if (!got.includes(norm(p.text))) { api.send({ type: 'termInput', id, data: '\x03' }); return showToast('Already delivered to the agent'); } // ↑ recalled history instead: clear it
    api.send({ type: 'termInput', id, data: '\x03' }); await wait(250);
    if (box()) return showToast("Couldn't clear the agent's prompt; check the terminal");
    list.splice(k, 1);
    for (const o of list) if (!o.held && o.text && got.includes(norm(o.text))) { api.send({ type: 'questPrompt', id, text: o.text }); await wait(400); } // the rest go back in the queue
    rerender();
  }

  // ── Permission mode: read live from the CLI's footer ("bypass permissions on", "plan mode on", …), since the
  // transcript only records it once per turn. Picking one in the menu presses Shift+Tab until the footer shows it. ──
  const MODE_RE = [['bypassPermissions', /bypass\s*permissions\s*on/i], ['acceptEdits', /accept\s*edits\s*on/i], ['plan', /plan\s*mode\s*on/i], ['auto', /auto\s*mode\s*on/i]];
  function liveMode(id) {
    const x = typeof xterms !== 'undefined' && xterms.get(id), b = x && x.terminal && x.terminal.buffer.active;
    if (!b) return null;
    let s = ''; for (let i = Math.max(0, b.length - 10); i < b.length; i++) s += (b.getLine(i)?.translateToString() || '') + ' ';
    for (const [m, re] of MODE_RE) if (re.test(s)) return m;
    return /for\s*shortcuts/i.test(s) ? 'default' : null; // the default mode's footer shows "? for shortcuts"
  }
  async function setMode(target) {
    const id = selectedId; closeModeMenu();
    for (let k = 0; k < 6 && liveMode(id) !== target; k++) { api.send({ type: 'termInput', id, data: '\x1b[Z' }); await new Promise(r => setTimeout(r, 300)); }
    if (liveMode(id) !== target && typeof showToast === 'function') showToast(`${MODES[target][0]} isn't available for this agent`);
    rerender();
  }
  // The model chip opens Overlord's own Switch model menu (index.html showModelMenu), placed just above the chip.
  function openModelMenu(chip) {
    const r = chip.getBoundingClientRect();
    showModelMenu({ stopPropagation() {}, preventDefault() {}, clientX: r.left, clientY: r.top }, selectedId);
    const m = document.getElementById('model-ctx-menu'); if (!m) return;
    const h = m.getBoundingClientRect();
    m.style.top = Math.max(8, r.top - h.height - 8) + 'px'; m.style.left = Math.max(8, Math.min(r.right - h.width, innerWidth - h.width - 8)) + 'px';
  }
  function closeModeMenu() { document.getElementById('chat-mode-menu')?.remove(); }
  function openModeMenu(chip, cur) {
    if (document.getElementById('chat-mode-menu')) return closeModeMenu();
    const m = document.createElement('div'); m.id = 'chat-mode-menu'; m.setAttribute('role', 'menu');
    m.innerHTML = ['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions'].map(k => `<button type="button" role="menuitemradio" aria-checked="${k === cur}" class="mm-i m-${MODES[k][1]}${k === cur ? ' on' : ''}" data-mode="${k}">${ICON.shield}<span>${MODES[k][0]}</span>${k === cur ? ICON.check : ''}</button>`).join('') + '<div class="mm-k"><kbd>Shift</kbd>+<kbd>Tab</kbd> cycles</div>';
    document.getElementById('term-order').appendChild(m);
    const r = chip.getBoundingClientRect(), o = document.getElementById('term-order').getBoundingClientRect();
    m.style.left = (r.left - o.left) + 'px';
    m.addEventListener('click', (e) => { const b = e.target.closest('[data-mode]'); if (b) setMode(b.dataset.mode); });
    setTimeout(() => document.addEventListener('mousedown', function off(e) { if (!m.contains(e.target) && !e.target.closest('.chip.mode')) { closeModeMenu(); } document.removeEventListener('mousedown', off, true); }, true), 0);
  }

  // ── Composer chips: permission mode (opens the mode menu), model · effort, context used ──
  function chipsHtml(a, mode) {
    const s = a.stats || {}, m = MODES[mode] || null;
    const win = typeof ctxWindow === 'function' ? ctxWindow(s.modelFamily, s.ctxTok) : 200000;
    const pct = s.ctxTok ? Math.min(100, Math.round(s.ctxTok / win * 100)) : 0, r = 7, c = 2 * Math.PI * r;
    const model = String(s.model || '').replace(/^claude-/, '').replace(/-(\d+)-(\d+).*$/, ' $1.$2').replace(/^\w/, x => x.toUpperCase());
    return (m ? `<button type="button" class="chip mode m-${m[1]}" data-act="mode" data-mode-cur="${escH(mode)}" aria-haspopup="menu" title="Permission mode">${ICON.shield}<span class="l">${m[0]}</span><span class="s">${m[2]}</span></button>` : '')
      + '<span class="grow"></span>'
      // Context left before auto-compact, once it matters (half used); click puts /compact in the box.
      + (pct >= 50 ? `<button type="button" class="chip ctx${pct > 80 ? ' hot' : ''}" data-insert="/compact" title="${pct}% of the context used. Click for /compact"><svg viewBox="0 0 18 18" aria-hidden="true"><circle cx="9" cy="9" r="${r}"/><circle class="v" cx="9" cy="9" r="${r}" stroke-dasharray="${((100 - pct) / 100 * c).toFixed(1)} ${c.toFixed(1)}"/></svg>${100 - pct}% left</button>` : '')
      + (model ? `<button type="button" class="chip model" data-act="model" aria-haspopup="menu" title="${escH(s.model)}">${escH(model)}${s.effort ? ` <em>${escH(s.effort)}</em>` : ''}</button>` : '');
  }

  // Draw the Chat view for agent a. Only blocks that changed are replaced, so a text selection and open rows
  // survive live ticks; new blocks slide in. Follows the bottom unless you scrolled up.
  let prevBusy = new Map(), tick = null, jumpOnce = false;
  const liveKey = (h) => h.replace(/(data-live="[^"]*">)[^<]*/g, '$1');
  function paint(el, id, a, evs, st) {
    const now = Date.now();
    const doneBy = new Map(); let mode = '';
    if (evs) for (const ev of evs) { if (ev.type === 'tool_done' && ev.toolId) doneBy.set(ev.toolId, ev); else if (ev.type === 'mode') mode = ev.mode; }
    mode = liveMode(id) || mode; // the footer is current; the transcript only notes the mode once per turn
    // The transcript outranks a stale "working": a turn whose end is the last thing written is over, whatever a
    // leftover per-call status in the list says.
    // (Covers "resuming" too: it can linger after Overlord reattaches an agent that has since finished.)
    if (evs && (st === 'active' || st === 'settling' || st === 'resuming')) { for (let k = evs.length - 1; k >= 0; k--) { const t = evs[k].type; if (t === 'mode' || t === 'tool_done' || t === 'images') continue; if (t === 'turn') st = 'waiting'; break; } }
    const busy = st === 'active' || st === 'resuming';
    const order = document.getElementById('term-order');
    order.classList.toggle('busy', busy); order.classList.toggle('dead', a.crashed === 'fatal');
    const chips = document.getElementById('chat-chips'); if (chips) { const ch = chipsHtml(a, mode); if (chips._h !== ch) chips.innerHTML = chips._h = ch; }
    document.getElementById('term').classList.toggle('chat-new', !!evs && !evs.length);
    let list;
    if (!evs) list = ['<div class="chat-empty"><span class="loading"></span></div>'];
    else if (!evs.length) list = [`<div class="chat-empty hello">${SPARK}<div>What are we building?</div></div>`];
    else list = blocks(evs, doneBy, a.cwd);
    if (busy && !prevBusy.get(id)) a._tok0 = (a.stats && a.stats.outTok) || 0; // tokens are counted from the turn's start
    const tail = (evs ? liveHtml(a, st, evs, doneBy, now) + pendingHtml(id, evs, busy) : ''); // queued text waits under the spinner, as in the CLI

    let thread = el.querySelector(':scope > .thread'), tailEl = el.querySelector(':scope > .tail');
    const fresh = el.dataset.for !== String(id) || !thread;
    if (fresh && window.chatComposer) chatComposer.drawAtt(); // another agent: its own pending images
    if (fresh) { el.innerHTML ='<div class="thread"></div><div class="tail"></div>'; thread = el.firstChild; tailEl = el.lastChild; el._blocks = []; el.dataset.for = String(id); }
    const stuck = !fresh && !jumpOnce && el.scrollTop + el.clientHeight < el.scrollHeight - 40;
    const old = el._blocks || [];
    for (let k = 0; k < list.length; k++) {
      if (old[k] === list[k]) continue;
      const tmp = document.createElement('div'); tmp.innerHTML = list[k];
      const node = tmp.firstElementChild || document.createElement('div');
      const cur = thread.children[k];
      if (cur) { keepOpen(cur, node); cur.replaceWith(node); }
      else { if (!fresh) node.classList.add('enter'); if (!fresh && node.classList.contains('turnfoot') && prevBusy.get(id)) node.classList.add('landed'); thread.appendChild(node); }
    }
    while (thread.children.length > list.length) thread.lastElementChild.remove();
    el._blocks = list;
    // The live tail ticks every second (elapsed, the CLI's verb, agent timers). When only that text changed, swap the
    // text in place: rebuilding would replay the slide-in and restart the spark and shimmer on every tick.
    if (tailEl._h !== tail) {
      const key = liveKey(tail);
      if (tailEl._k === key) { const tmp = document.createElement('div'); tmp.innerHTML = tail; for (const n of tmp.querySelectorAll('[data-live]')) { const c = tailEl.querySelector(`[data-live="${CSS.escape(n.dataset.live)}"]`); if (c && c.textContent !== n.textContent) c.textContent = n.textContent; } }
      else tailEl.innerHTML = tail;
      tailEl._h = tail; tailEl._k = key;
    }
    prevBusy.set(id, busy);
    // The working line's elapsed time ticks once a second while the agent works and the view is open.
    if (busy && !tick) tick = setInterval(() => { if (!el.classList.contains('open')) { clearInterval(tick); tick = null; return; } rerender(); }, 1000);
    else if (!busy && tick) { clearInterval(tick); tick = null; }
    if (!stuck) {
      el.scrollTop = el.scrollHeight;
      // Images grow the thread as they load: stay pinned to the bottom through that.
      for (const i of el.querySelectorAll('img')) if (!i.complete) i.addEventListener('load', () => { if (el.scrollHeight - el.scrollTop - el.clientHeight < i.offsetHeight + 120) el.scrollTop = el.scrollHeight; }, { once: true });
    }
    jumpOnce = false;
    for (const s of thread.querySelectorAll('.trow.running .el')) s.textContent = '· ' + dur(now - +s.dataset.t); // running calls tick in place
    drawRail(el, evs);
    syncJump(el);
  }
  // A replaced block keeps its open tool rows and expanded prompt.
  function keepOpen(cur, node) {
    const open = new Set([...cur.querySelectorAll('details[open]'), ...(cur.matches('details[open]') ? [cur] : [])].map(d => d.dataset.tid));
    for (const d of [...node.querySelectorAll('details[data-tid]'), ...(node.matches('details[data-tid]') ? [node] : [])]) if (open.has(d.dataset.tid)) d.open = true;
    const b = cur.querySelector('.bubble.open'), nb = node.querySelector('.bubble.long');
    if (b && nb) { nb.classList.add('open'); nb.nextElementSibling.textContent = 'Show less'; }
  }
  // The round "jump to latest" button over the composer, shown while you're scrolled up; the prompt rail follows too.
  function syncJump(el) { const b = document.getElementById('chat-jump'); if (b) b.classList.toggle('show', el.scrollTop + el.clientHeight < el.scrollHeight - 200); railActive(el); }

  // ── Prompt rail, as on the terminal: a dash per prompt down the right edge, hover lists them, click jumps there ──
  const rail = document.createElement('div'); rail.id = 'chat-rail'; rail.innerHTML = '<div class="cr-dashes"></div><div class="cr-pop"></div>';
  document.getElementById('term').appendChild(rail);
  function drawRail(el, evs) {
    const ps = (evs || []).map((e, i) => [e, i]).filter(([e]) => e.type === 'prompt' || e.type === 'command');
    const key = ps.map(([, i]) => i).join(',');
    rail.classList.toggle('has', ps.length > 1);
    if (rail._k === key) return; rail._k = key;
    const label = (t) => escH(String(t || '').replace(/\[Image #\d+\]/g, '🖼').replace(/\s+/g, ' ').trim().slice(0, 140) || '🖼');
    rail.querySelector('.cr-dashes').innerHTML = ps.map(([, i]) => `<i data-i="${i}"></i>`).join('');
    rail.querySelector('.cr-pop').innerHTML = ps.map(([e, i]) => `<div data-i="${i}">${label(e.text)}</div>`).join('');
    railActive(el);
  }
  // The prompt at the top of the view is the one lit.
  function railActive(el) {
    if (!rail.classList.contains('has')) return;
    const top = el.getBoundingClientRect().top + 40; let on = null;
    for (const u of el.querySelectorAll('.thread > .msg.user[data-i], .thread > .msg.cmd[data-i]')) { if (u.getBoundingClientRect().top <= top) on = u.dataset.i; else break; }
    if (on == null) { const f = el.querySelector('.thread > .msg.user[data-i]'); on = f && f.dataset.i; }
    for (const n of rail.querySelectorAll('[data-i]')) n.classList.toggle('on', n.dataset.i === on);
  }
  rail.addEventListener('click', (e) => {
    const t = e.target.closest('[data-i]'); if (!t) return;
    const m = document.querySelector(`#conversation .thread > [data-i="${t.dataset.i}"]`);
    if (m) { m.scrollIntoView({ block: 'start', behavior: 'smooth' }); m.classList.remove('flash'); void m.offsetWidth; m.classList.add('flash'); }
  });
  rail.addEventListener('mouseenter', () => { const on = rail.querySelector('.cr-pop .on'); if (on) on.scrollIntoView({ block: 'nearest' }); });

  // Keys typed into the agent's terminal one write at a time, so the TUI reads each as its own key press.
  function keys(list) { const id = selectedId; list.forEach((k, n) => setTimeout(() => api.send({ type: 'termInput', id, data: k }), n * 70)); }

  // Clicks inside the view and on the composer chips.
  function onClick(e, a, evs) {
    const cwd = a && a.cwd;
    const k = e.target.closest('[data-keys]'); // permission card: the same keys the terminal menu takes
    if (k && selectedId != null) { keys([k.dataset.keys === 'esc' ? '\x1b' : k.dataset.keys]); return; }
    const pick = e.target.closest('[data-pick]'); // question card: arrow down to the option, then Enter
    if (pick && selectedId != null) { keys([...Array(+pick.dataset.pick).fill('\x1b[B'), '\r']); pick.classList.add('picked'); return; }
    const tag = e.target.closest('.imgtag[data-src]'); // an [Image #N] chip opens the image it names
    if (tag) { lightbox(tag.dataset.src); return; }
    const img = e.target.closest('.imgs img'); // a thumbnail opens full size
    if (img) { lightbox(img.src); return; }
    const uq = e.target.closest('[data-unqueue]'); // ✕ on a queued prompt: take it back, the agent keeps working
    if (uq) { unqueue(selectedId, +uq.dataset.unqueue); return; }
    const sh = e.target.closest('[data-bgout]'); // a background shell's chip: its live output
    if (sh) { openShell(sh.dataset.bgout, sh.dataset.bgname); return; }
    const jump = e.target.closest('[data-jump]'); // a background agent's chip: open and show its call
    if (jump) { const d = document.querySelector(`#conversation details[data-tid="${CSS.escape(jump.dataset.jump)}"]`); if (d) { const g = d.parentElement.closest('details'); if (g) g.open = true; d.open = true; d.scrollIntoView({ block: 'center', behavior: 'smooth' }); d.classList.remove('flash'); void d.offsetWidth; d.classList.add('flash'); } return; }
    const ins = e.target.closest('[data-insert]'); // composer chips: /compact, /model
    if (ins) { chatComposer.insert(ins.dataset.insert, false); return; }
    const act = e.target.closest('[data-act]');
    if (act) {
      const lastPrompt = () => { for (let k = (evs || []).length - 1; k >= 0; k--) if (evs[k].type === 'prompt' && evs[k].text) return evs[k].text; return ''; };
      if (act.dataset.act === 'resume') resumeSelected();
      else if (act.dataset.act === 'retry') { const t = lastPrompt(); if (t) { api.send({ type: 'questPrompt', id: selectedId, text: t }); chatUi.addPending(selectedId, t); rerender(); } }
      else if (act.dataset.act === 'edit-prompt') chatComposer.insert(lastPrompt(), false);
      else if (act.dataset.act === 'turn-edits') { // open every edit of that turn and bring the first into view
        const from = +act.dataset.from, to = +act.dataset.to; let first = null;
        for (const d of document.querySelectorAll('#conversation details.trow.k-edit')) {
          const i = (evs || []).findIndex(x => x.toolId === d.dataset.tid); if (i < from || i > to) continue;
          const g = d.parentElement.closest('details'); if (g) g.open = true; d.open = true; first = first || d;
        }
        if (first) first.scrollIntoView({ block: 'start', behavior: 'smooth' });
      }
      else if (act.dataset.act === 'mode') openModeMenu(act, act.dataset.modeCur);
      else if (act.dataset.act === 'model') openModelMenu(act);
      else { switchTermTab('terminal'); askFlip = true; const x = xterms.get(selectedId); if (x) x.terminal.focus(); }
      return;
    }
    const flash = (btn) => { btn.classList.add('done'); setTimeout(() => btn.classList.remove('done'), 1200); };
    const copy = e.target.closest('.md-copy');
    if (copy) { navigator.clipboard.writeText(copy.closest('.md-code').querySelector('code').textContent).then(() => { copy.textContent = 'Copied'; setTimeout(() => { copy.textContent = 'Copy'; }, 1200); }); return; }
    const cp = e.target.closest('.act.copy');
    if (cp) { const ev = evs && evs[+cp.closest('[data-i]').dataset.i]; if (ev) navigator.clipboard.writeText(ev.text).then(() => flash(cp)); return; }
    const more = e.target.closest('.more');
    if (more) { const b = more.previousElementSibling; b.classList.toggle('open'); more.textContent = b.classList.contains('open') ? 'Show less' : 'Show more'; return; }
    const link = e.target.closest('a[href]'); if (!link) return;
    e.preventDefault();
    const c = classifyHref(link.dataset.href || link.getAttribute('href'), (cwd || '').replace(/\\/g, '/') + '/_');
    if (c.kind === 'external') api.send({ type: 'openUrl', url: c.url });
    else if (c.kind === 'doc') api.send({ type: 'docOpen', paths: [c.path] });
    else if (c.kind === 'file') api.send({ type: 'docOpenWith', path: c.path });
  }

  // An image full size over the app; a click or Esc closes it.
  function lightbox(src) {
    const d = document.createElement('div'); d.className = 'chat-lightbox'; d.innerHTML = `<img src="${escH(src)}" alt="">`;
    const close = () => { d.remove(); document.removeEventListener('keydown', key, true); };
    const key = (e) => { if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); close(); } };
    d.onclick = close; document.addEventListener('keydown', key, true); document.body.appendChild(d);
  }
  document.getElementById('chat-att').addEventListener('click', (e) => { const i = e.target.closest('img'); if (i) lightbox(i.src); });

  // Opening a run of calls that had a failure opens the failed call too: "1 failed" should show which.
  document.getElementById('conversation').addEventListener('toggle', (e) => { const d = e.target; if (d.matches && d.matches('details.tgroup') && d.open) { const f = d.querySelector('details.trow.err'); if (f) f.open = true; } }, true);

  // ── A background shell's live output: a panel over the view, re-read every 2 s while it's open ──
  let shellTimer = null;
  function openShell(file, name) {
    closeShell();
    const d = document.createElement('div'); d.id = 'chat-shell';
    d.innerHTML = `<div class="sh-h">${ICON.cmd}<span>${escH(name)}</span><button type="button" class="sh-x" aria-label="Close">×</button></div><pre class="sh-out">…</pre>`;
    d.querySelector('.sh-x').onclick = closeShell; d.dataset.file = file;
    document.getElementById('term').appendChild(d);
    const pull = () => api.send({ type: 'bgTail', id: selectedId, file });
    pull(); shellTimer = setInterval(pull, 2000);
  }
  function closeShell() { clearInterval(shellTimer); shellTimer = null; document.getElementById('chat-shell')?.remove(); }

  // ── A subagent's own steps, fetched when its Agent row is opened ──
  const steps = new Map(); // toolId → events
  document.getElementById('conversation').addEventListener('toggle', (e) => {
    const d = e.target; if (!d.matches || !d.matches('details.trow.k-agent') || !d.open) return;
    const tid = d.dataset.tid; if (!tid) return;
    if (steps.has(tid)) return drawSteps(d, steps.get(tid));
    const evs = (worldTl && worldTl.id === selectedId) ? worldTl.events : [], done = evs.find(x => x.type === 'tool_done' && x.toolId === tid);
    api.send({ type: 'agentSteps', id: selectedId, toolId: tid, agentId: done && done.agentId });
  }, true);
  function drawSteps(d, evs) {
    let box = d.querySelector('.agent-steps'); if (!box) { box = document.createElement('div'); box.className = 'agent-steps'; d.querySelector('.tbody')?.prepend(box); }
    const doneBy = new Map(); for (const ev of evs) if (ev.type === 'tool_done') doneBy.set(ev.toolId, ev);
    const tools = evs.filter(ev => ev.type === 'tool');
    box.innerHTML = tools.length ? `<div class="as-h">${tools.length} step${tools.length > 1 ? 's' : ''}</div>` + tools.map(ev => toolRow(ev, doneBy.get(ev.toolId), '')).join('') : '<div class="as-h">No steps recorded</div>';
  }
  function onMsg(msg) {
    if (msg.type === 'agentSteps') { steps.set(msg.toolId, msg.events || []); const d = document.querySelector(`#conversation details.trow.k-agent[data-tid="${CSS.escape(msg.toolId)}"]`); if (d && d.open) drawSteps(d, msg.events || []); }
    if (msg.type === 'bgTail') { const p = document.getElementById('chat-shell'); if (p && p.dataset.file === msg.file) { const o = p.querySelector('.sh-out'), atEnd = o.scrollTop + o.clientHeight >= o.scrollHeight - 20; o.textContent = msg.ok ? (msg.text || '(no output yet)') : 'The output file is gone: the shell has finished.'; if (atEnd) o.scrollTop = o.scrollHeight; } }
  }

  // ── "Ask about this": select text in a reply and a small button quotes it into the composer ──
  const quoteBtn = document.createElement('button'); quoteBtn.type = 'button'; quoteBtn.id = 'chat-quote'; quoteBtn.innerHTML = `${ICON.ask}<span>Ask about this</span>`; quoteBtn.hidden = true;
  document.body.appendChild(quoteBtn);
  document.getElementById('conversation').addEventListener('mouseup', () => setTimeout(() => {
    const sel = getSelection(), t = sel && String(sel).trim();
    const inReply = t && sel.anchorNode && sel.anchorNode.parentElement && sel.anchorNode.parentElement.closest('#conversation .msg.ai, #conversation .tbody');
    if (!inReply) { quoteBtn.hidden = true; return; }
    const r = sel.getRangeAt(0).getBoundingClientRect();
    quoteBtn.style.left = Math.min(innerWidth - 150, r.left + r.width / 2 - 60) + 'px'; quoteBtn.style.top = Math.max(8, r.top - 40) + 'px'; quoteBtn.hidden = false; quoteBtn._text = t;
  }, 0));
  document.addEventListener('mousedown', (e) => { if (e.target.closest && !e.target.closest('#chat-quote')) quoteBtn.hidden = true; });
  quoteBtn.addEventListener('mousedown', (e) => e.preventDefault()); // keep the selection
  quoteBtn.addEventListener('click', () => { const q = quoteBtn._text.split('\n').map(l => '> ' + l).join('\n') + '\n\n'; quoteBtn.hidden = true; getSelection().removeAllRanges(); chatComposer.insert(q, false); });

  // ── Find in chat (Ctrl+F): matches lit with the CSS highlight API (no DOM changes), Enter / Shift+Enter step ──
  let find = null; // { ranges, i }
  function openFind() {
    let bar = document.getElementById('chat-find');
    if (!bar) {
      bar = document.createElement('div'); bar.id = 'chat-find';
      bar.innerHTML = `${ICON.search}<input type="text" placeholder="Find in chat" spellcheck="false"><span class="cf-n"></span><button type="button" data-d="-1" aria-label="Previous">↑</button><button type="button" data-d="1" aria-label="Next">↓</button><button type="button" class="cf-x" aria-label="Close">×</button>`;
      document.getElementById('term').appendChild(bar);
      const inp = bar.querySelector('input');
      inp.addEventListener('input', () => runFind(inp.value));
      inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); stepFind(e.shiftKey ? -1 : 1); } else if (e.key === 'Escape') { e.preventDefault(); closeFind(); } });
      bar.addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; if (b.classList.contains('cf-x')) closeFind(); else stepFind(+b.dataset.d); });
    }
    bar.hidden = false; const inp = bar.querySelector('input'); inp.focus(); inp.select(); if (inp.value) runFind(inp.value);
  }
  function runFind(q) {
    const root = document.querySelector('#conversation .thread'), ranges = [];
    if (q && root) {
      for (const d of root.querySelectorAll('details')) d.dataset.findOpen = d.open ? '1' : ''; // matches inside closed rows still count
      const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT), lq = q.toLowerCase();
      for (let n = walk.nextNode(); n && ranges.length < 2000; n = walk.nextNode()) {
        const t = n.nodeValue.toLowerCase(); let k = t.indexOf(lq);
        while (k >= 0) { const r = new Range(); r.setStart(n, k); r.setEnd(n, k + q.length); ranges.push(r); k = t.indexOf(lq, k + q.length); }
      }
    }
    find = { ranges, i: ranges.length ? 0 : -1 };
    showFind();
  }
  function stepFind(d) { if (!find || !find.ranges.length) return; find.i = (find.i + d + find.ranges.length) % find.ranges.length; showFind(); }
  function showFind() {
    if (!window.CSS || !CSS.highlights) return;
    const all = find ? find.ranges : [], cur = find && find.i >= 0 ? all[find.i] : null;
    CSS.highlights.set('chat-find', new Highlight(...all)); CSS.highlights.set('chat-find-cur', cur ? new Highlight(cur) : new Highlight());
    const n = document.querySelector('#chat-find .cf-n'); if (n) n.textContent = all.length ? `${find.i + 1}/${all.length}` : (document.querySelector('#chat-find input').value ? '0' : '');
    if (cur) { const el = cur.startContainer.parentElement; let d = el.closest('details'); while (d) { d.open = true; d = d.parentElement.closest('details'); } el.scrollIntoView({ block: 'center' }); }
  }
  function closeFind() { const bar = document.getElementById('chat-find'); if (bar) bar.hidden = true; if (window.CSS && CSS.highlights) { CSS.highlights.delete('chat-find'); CSS.highlights.delete('chat-find-cur'); } find = null; document.getElementById('term-order-input').focus(); }

  // Ctrl+↑/↓: the previous / next of your prompts, like the terminal's prompt jump.
  function jumpPrompt(dir) {
    const el = document.getElementById('conversation'), us = [...el.querySelectorAll('.thread > .msg.user[data-i], .thread > .msg.cmd[data-i]')]; if (!us.length) return;
    const top = el.getBoundingClientRect().top + 8, y = (u) => u.getBoundingClientRect().top;
    const target = dir < 0 ? [...us].reverse().find(u => y(u) < top - 4) : us.find(u => y(u) > top + 4);
    if (target) { target.scrollIntoView({ block: 'start', behavior: 'smooth' }); target.classList.remove('flash'); void target.offsetWidth; target.classList.add('flash'); }
  }

  // ── Side by side: terminal left, chat right (chat.css #term.split); remembered ──
  function toggleSplit(on) {
    const t = document.getElementById('term'); on = on ?? !t.classList.contains('split');
    t.classList.toggle('split', on); document.getElementById('hdr-split')?.classList.toggle('on', on);
    try { localStorage.setItem('chatSplit', on ? '1' : ''); } catch {}
    if (termTab === 'conversation') switchTermTab('conversation');
    if (typeof schedFit === 'function') setTimeout(schedFit, 50);
  }
  try { if (localStorage.getItem('chatSplit') === '1') { document.getElementById('term').classList.add('split'); document.getElementById('hdr-split')?.classList.add('on'); } } catch {}

  window.chatUi = { toggleSplit, openFind, closeFind, jumpPrompt, onMsg, paint, onClick, syncJump, SPARK, keys, addPending: (id, text, imgs = [], held = false) => { if (!pending.has(id)) pending.set(id, []); pending.get(id).push({ text, imgs, held, at: Date.now() }); jumpOnce = true; }, releasePending: (id) => { const p = (pending.get(id) || []).find(x => x.held); if (p) { p.held = false; p.at = Date.now(); } }, onMdReady: (fn) => { rerender = fn; } };
})();
