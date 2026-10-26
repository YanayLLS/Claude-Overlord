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
    alert: svg('<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/>'),
  };
  // Claude's spark: turning while the agent works, popping once when a turn lands.
  const SPARK = '<svg class="spark" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.5l1.6 6.2 5.6-3.2-3.2 5.6 6.2 1.6-6.2 1.6 3.2 5.6-5.6-3.2L12 21.5l-1.6-6.2-5.6 3.2 3.2-5.6L1.8 12l6.2-1.6-3.2-5.6 5.6 3.2z"/></svg>';
  const MODES = { bypassPermissions: ['Bypass permissions', 'bypass'], acceptEdits: ['Accept edits', 'accept'], plan: ['Plan mode', 'plan'], default: ['Ask first', 'ask'] };

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
    else if (a.todos) body = todoHtml(a.todos);
    else if (a.plan) body = `<div class="md sub">${md(a.plan, cwd)}</div>`;
    else if (v.kind === 'ask') body = (a.options || []).length ? '<ul class="opts">' + a.options.map(o => `<li>${escH(o.label ?? o)}</li>`).join('') + '</ul>' + (out && !err ? `<div class="answer">${escH(out)}</div>` : '') : '';
    else if (v.kind === 'cmd') body = `<div class="io${err ? ' err' : ''}"><div class="io-r"><span class="lbl">IN</span><pre>${escH(a.command || '')}</pre></div>${out ? `<div class="io-r"><span class="lbl">OUT</span><pre>${escH(out)}</pre></div>` : ''}</div>`;
    else if (v.kind === 'agent' && out) body = `<div class="md sub">${md(out, cwd)}</div>`;
    else if (out) body = `<pre class="out${err ? ' err' : ''}">${escH(out)}</pre>`;
    const cls = `trow k-${v.kind}${running ? ' running' : ''}${err ? ' err' : ''}${ev.type === 'subtask' ? ' sub' : ''}`;
    const head = `${ICON[v.kind] || ICON.tool}<span class="verb">${escH(v.verb)}</span>${v.target ? `<span class="tgt${v.mono ? ' mono' : ''}" title="${escH(v.target)}">${escH(v.target)}</span>` : ''}${stat}`;
    const h = body ? `<details class="${cls}" data-tid="${escH(ev.toolId || '')}"><summary>${head}${ICON.chev}</summary><div class="tbody">${body}</div></details>` : `<div class="${cls}"><div class="sumrow">${head}</div></div>`;
    toolCache.set(ev, [done, h]);
    return h;
  }
  // A run of calls between two messages: one call shows as itself; more fold into one summary line.
  function groupHtml(tools, doneBy, cwd) {
    const rows = tools.map(ev => toolRow(ev, doneBy.get(ev.toolId), cwd));
    if (tools.length === 1) return `<div class="tools">${rows[0]}</div>`;
    const errs = tools.filter(ev => (doneBy.get(ev.toolId) || {}).err).length;
    const running = tools.some(ev => ev.toolId && !doneBy.get(ev.toolId));
    return `<div class="tools"><details class="tgroup${running ? ' running' : ''}" data-tid="g:${escH(tools[0].toolId || '')}"><summary><span class="gl">${escH(groupSummary(tools))}</span>${errs ? `<span class="errs">${errs} failed</span>` : ''}${ICON.chev}</summary><div class="tlist">${rows.join('')}</div></details></div>`;
  }

  function msgHtml(ev, i, cwd) {
    let h = cache.get(ev); if (h != null) return h;
    if (ev.type === 'prompt') {
      const imgs = (ev.images || []).map(src => `<img src="${escH(src)}" alt="">`).join('');
      const text = (ev.text || '').replace(/\s*\[Image #\d+\]\s*/g, ' ').trim();
      const long = text.length > 900 || text.split('\n').length > 14;
      h = `<div class="msg user" data-i="${i}">${imgs ? `<div class="imgs">${imgs}</div>` : ''}${text ? `<div class="bubble${long ? ' long' : ''}">${escH(text)}</div>${long ? '<button class="more" type="button">Show more</button>' : ''}` : ''}</div>`;
    } else if (ev.type === 'text') h = `<div class="msg ai" data-i="${i}"><div class="md">${md(ev.text, cwd)}</div></div>`;
    else if (ev.type === 'command') h = `<div class="msg cmd"><span>${escH(ev.text)}</span></div>`;
    else if (ev.type === 'interrupt') h = '<div class="msg note">⎿ Interrupted</div>';
    else if (ev.type === 'compact') h = '<div class="msg divider"><span>Conversation compacted</span></div>';
    else h = '';
    if (mdReady || ev.type !== 'text') cache.set(ev, h);
    return h;
  }
  // Under a finished turn: copy its last reply · how long it worked · when it finished — the CLI's "Cogitated for 42s".
  function footHtml(textAt, turn) {
    const meta = turn ? `<span class="tf-meta">${SPARK}Worked ${escH(dur(turn.ms))}${turn.ts ? ' · ' + escH(clock(turn.ts)) : ''}</span>` : '';
    return `<div class="turnfoot"${textAt >= 0 ? ` data-i="${textAt}"` : ''}>${textAt >= 0 ? `<button class="act copy" type="button" title="Copy reply" aria-label="Copy reply">${ICON.copy}</button>` : ''}${meta}</div>`;
  }

  // The transcript as blocks (one per message, tool run or turn footer), so paint can swap only what changed.
  // A turn's footer waits until the turn is over: its turn_duration line, or the next prompt.
  function blocks(evs, doneBy, cwd) {
    const out = []; let run = [], textAt = -1, turn = null, open = false;
    const flush = () => { if (run.length) out.push(groupHtml(run, doneBy, cwd)); run = []; };
    const close = () => { flush(); if (open && (textAt >= 0 || turn)) out.push(footHtml(textAt, turn)); textAt = -1; turn = null; open = false; };
    evs.forEach((ev, i) => {
      const t = ev.type;
      if (t === 'tool' && ev.name === 'AskUserQuestion' && !doneBy.get(ev.toolId)) return; // the question card shows it
      if (t === 'tool' || t === 'subtask') { run.push(ev); open = true; return; }
      if (t === 'tool_done' || t === 'mode') return;
      if (t === 'turn') { turn = ev; return; }
      if (t === 'prompt' || t === 'command') close();
      flush(); out.push(msgHtml(ev, i, cwd));
      if (t === 'text') { textAt = i; open = true; }
    });
    flush(); if (turn) close();
    return out;
  }

  // ── Live tail: what the CLI shows under the transcript ──
  const lastTool = (evs, name, doneBy) => { for (let k = evs.length - 1; k >= 0; k--) { const e = evs[k]; if (e.type === 'tool' && e.name === name) return doneBy && doneBy.get(e.toolId) ? null : e; if (e.type === 'prompt') return null; } return null; };
  function permHtml(perm) {
    const n = perm.name || '', title = n === 'Bash' || n === 'PowerShell' ? 'Run this command?' : /^(Edit|Write|MultiEdit|NotebookEdit)$/.test(n) ? 'Make this edit?' : /^Web/.test(n) ? 'Fetch this page?' : `Allow ${escH(n.replace(/^mcp__[^_]+__/, '')) || 'this action'}?`;
    const kind = toolView({ name: n }).kind;
    return `<div class="card perm"><div class="card-h">${ICON[kind] || ICON.shield}<span>${title}</span></div><pre>${escH(perm.status || n)}</pre><div class="btns"><button class="primary" type="button" data-keys="1">Allow once<kbd>1</kbd></button><button type="button" data-keys="2">Always allow<kbd>2</kbd></button><button type="button" data-keys="esc">Deny<kbd>Esc</kbd></button></div></div>`;
  }
  function askHtml(ask, perm) {
    const a = (ask && ask.args) || {}, opts = a.options || [];
    const q = a.question || (perm && perm.status) || 'Claude has a question';
    return `<div class="card ask"><div class="card-h">${ICON.ask}<span>${escH(q)}</span></div><div class="choices">${opts.map((o, k) => `<button type="button" data-pick="${k}"><kbd>${k + 1}</kbd><span class="ch-t"><b>${escH(o.label ?? o)}</b>${o.desc ? `<small>${escH(o.desc)}</small>` : ''}</span></button>`).join('')}<button type="button" class="other" data-act="answer"><kbd>…</kbd><span>${opts.length ? 'Something else' : 'Answer in terminal'}</span></button></div></div>`;
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
    // Background agents still running (Agent/Task calls without a result).
    const bg = evs.filter(e => e.type === 'tool' && (e.name === 'Agent' || e.name === 'Task') && !doneBy.get(e.toolId));
    if (bg.length) h += `<div class="bg-agents">${bg.map(e => `<div class="bga">${ICON.agent}<span class="bga-n">${escH((e.args && (e.args.description || e.args.subagent_type)) || 'Agent')}</span><span class="bga-t">${e.ts ? escH(dur(now - Date.parse(e.ts))) : ''}</span><span class="bga-dot"></span></div>`).join('')}</div>`;
    if (perm && perm.perm === 'ask') return h + askHtml(lastTool(evs, 'AskUserQuestion', doneBy), perm);
    if (perm) return h + permHtml(perm);
    if (a.crashed === 'fatal') return h + `<div class="card err"><div class="card-h">${ICON.alert}<span>The agent stopped</span></div><p>Process exited after ${a.crashCount}/${a.crashMax} attempts.</p><div class="btns"><button class="primary" type="button" data-act="resume">Resume</button></div></div>`;
    if (a.compacting) return h + `<div class="working">${SPARK}<span class="shimmer">Compacting conversation…</span></div>`;
    if (st === 'active' || st === 'resuming') {
      // The CLI's own playful verb ("Cogitating…") when it has one; the call in flight under it; elapsed; the Esc hint.
      const tool = (() => { for (let k = evs.length - 1; k >= 0; k--) { const e = evs[k]; if ((e.type === 'tool') && e.toolId && !doneBy.get(e.toolId) && e.name !== 'Agent' && e.name !== 'Task') return e; if (e.type === 'prompt') return null; } return null; })();
      const v = tool ? toolView(tool, true) : null;
      // Elapsed and tokens written this turn, like the CLI's "(1m 4s · ↓ 3.2k tokens · esc to interrupt)".
      const tok = a.stats && a._tok0 != null ? (a.stats.outTok || 0) - a._tok0 : 0;
      const meta = [a.activeAt ? dur(now - a.activeAt) : '', tok > 0 ? '↓ ' + (tok >= 1000 ? (tok / 1000).toFixed(1) + 'k' : tok) + ' tokens' : ''].filter(Boolean).map(escH).join(' · ');
      return h + `<div class="working">${SPARK}<span class="shimmer">${escH(a.spinnerText || (bg.length ? `Waiting for ${bg.length} background agent${bg.length > 1 ? 's' : ''}…` : 'Thinking…'))}</span>${v ? `<span class="w-tool">${escH(v.verb)} <span class="mono">${escH(v.target)}</span></span>` : ''}<span class="w-hint">${meta}${meta ? ' · ' : ''}<kbd>Esc</kbd> to interrupt</span></div>`;
    }
    return h;
  }

  // A prompt sent from the composer shows at once, dimmed, until the transcript writes it (or the agent queues it).
  const pending = new Map(); // agent id → { text, at }
  function pendingHtml(id, evs, busy) {
    const p = pending.get(id); if (!p) return '';
    const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
    if (evs.some(e => e.type === 'prompt' && e.ts && Date.parse(e.ts) >= p.at - 2000 && norm(e.text) === norm(p.text)) || Date.now() - p.at > 120000) { pending.delete(id); return ''; }
    return `<div class="msg user pending"><div class="bubble">${escH(p.text)}</div><span class="q">${busy ? 'Queued' : 'Sending…'}</span></div>`;
  }

  // ── Composer chips: permission mode (click cycles it, like Shift+Tab), model · effort, context used ──
  function chipsHtml(a, mode) {
    const s = a.stats || {}, m = MODES[mode] || null;
    const win = typeof ctxWindow === 'function' ? ctxWindow(s.modelFamily, s.ctxTok) : 200000;
    const pct = s.ctxTok ? Math.min(100, Math.round(s.ctxTok / win * 100)) : 0, r = 7, c = 2 * Math.PI * r;
    const model = String(s.model || '').replace(/^claude-/, '').replace(/-(\d+)-(\d+).*$/, ' $1.$2').replace(/^\w/, x => x.toUpperCase());
    return (m ? `<button type="button" class="chip mode m-${m[1]}" data-act="mode" title="Permission mode (Shift+Tab cycles)">${ICON.shield}<span>${m[0]}</span></button>` : '')
      + '<span class="grow"></span>'
      // Context left before auto-compact, once it matters (half used); click puts /compact in the box.
      + (pct >= 50 ? `<button type="button" class="chip ctx${pct >= 80 ? ' hot' : ''}" data-insert="/compact" title="${pct}% of the context used. Click for /compact"><svg viewBox="0 0 18 18" aria-hidden="true"><circle cx="9" cy="9" r="${r}"/><circle class="v" cx="9" cy="9" r="${r}" stroke-dasharray="${(pct / 100 * c).toFixed(1)} ${c.toFixed(1)}"/></svg>${100 - pct}% left</button>` : '')
      + (model ? `<button type="button" class="chip model" data-insert="/model " title="${escH(s.model)}. Click for /model">${escH(model)}${s.effort ? ` <em>${escH(s.effort)}</em>` : ''}</button>` : '');
  }

  // Draw the Chat view for agent a. Only blocks that changed are replaced, so a text selection and open rows
  // survive live ticks; new blocks slide in. Follows the bottom unless you scrolled up.
  let prevBusy = new Map(), tick = null;
  function paint(el, id, a, evs, st) {
    const now = Date.now();
    const doneBy = new Map(); let mode = '';
    if (evs) for (const ev of evs) { if (ev.type === 'tool_done' && ev.toolId) doneBy.set(ev.toolId, ev); else if (ev.type === 'mode') mode = ev.mode; }
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
    const tail = (evs ? pendingHtml(id, evs, busy) + liveHtml(a, st, evs, doneBy, now) : '');

    let thread = el.querySelector(':scope > .thread'), tailEl = el.querySelector(':scope > .tail');
    const fresh = el.dataset.for !== String(id) || !thread;
    if (fresh) { el.innerHTML = '<div class="thread"></div><div class="tail"></div>'; thread = el.firstChild; tailEl = el.lastChild; el._blocks = []; el.dataset.for = String(id); }
    const stuck = !fresh && el.scrollTop + el.clientHeight < el.scrollHeight - 40;
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
    if (tailEl._h !== tail) { tailEl.innerHTML = tailEl._h = tail; }
    prevBusy.set(id, busy);
    // The working line's elapsed time ticks once a second while the agent works and the view is open.
    if (busy && !tick) tick = setInterval(() => { if (!el.classList.contains('open')) { clearInterval(tick); tick = null; return; } rerender(); }, 1000);
    else if (!busy && tick) { clearInterval(tick); tick = null; }
    if (!stuck) el.scrollTop = el.scrollHeight;
    syncJump(el);
  }
  // A replaced block keeps its open tool rows and expanded prompt.
  function keepOpen(cur, node) {
    const open = new Set([...cur.querySelectorAll('details[open]'), ...(cur.matches('details[open]') ? [cur] : [])].map(d => d.dataset.tid));
    for (const d of [...node.querySelectorAll('details[data-tid]'), ...(node.matches('details[data-tid]') ? [node] : [])]) if (open.has(d.dataset.tid)) d.open = true;
    const b = cur.querySelector('.bubble.open'), nb = node.querySelector('.bubble.long');
    if (b && nb) { nb.classList.add('open'); nb.nextElementSibling.textContent = 'Show less'; }
  }
  // The round "jump to latest" button over the composer, shown while you're scrolled up.
  function syncJump(el) { const b = document.getElementById('chat-jump'); if (b) b.classList.toggle('show', el.scrollTop + el.clientHeight < el.scrollHeight - 200); }

  // Keys typed into the agent's terminal one write at a time, so the TUI reads each as its own key press.
  function keys(list) { const id = selectedId; list.forEach((k, n) => setTimeout(() => api.send({ type: 'termInput', id, data: k }), n * 70)); }

  // Clicks inside the view and on the composer chips.
  function onClick(e, a, evs) {
    const cwd = a && a.cwd;
    const k = e.target.closest('[data-keys]'); // permission card: the same keys the terminal menu takes
    if (k && selectedId != null) { keys([k.dataset.keys === 'esc' ? '\x1b' : k.dataset.keys]); return; }
    const pick = e.target.closest('[data-pick]'); // question card: arrow down to the option, then Enter
    if (pick && selectedId != null) { keys([...Array(+pick.dataset.pick).fill('\x1b[B'), '\r']); pick.classList.add('picked'); return; }
    const ins = e.target.closest('[data-insert]'); // composer chips: /compact, /model
    if (ins) { chatComposer.insert(ins.dataset.insert, false); return; }
    const act = e.target.closest('[data-act]');
    if (act) {
      if (act.dataset.act === 'resume') resumeSelected();
      else if (act.dataset.act === 'mode') keys(['\x1b[Z']); // Shift+Tab: the CLI cycles its permission mode
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

  window.chatUi = { paint, onClick, syncJump, SPARK, keys, addPending: (id, text) => pending.set(id, { text, at: Date.now() }), onMdReady: (fn) => { rerender = fn; } };
})();
