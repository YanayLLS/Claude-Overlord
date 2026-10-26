// Chat view: the agent's transcript drawn like Claude's desktop app. Replies in markdown, your prompts as bubbles,
// each run of tool calls folded into one line ("Ran 2 commands, read 3 files") that opens to the calls, and each call
// to its command + output or its diff. Fed by the timeline events (timeline-core.js); index.html's renderConversation
// owns the live state (permission cards, working indicator) and calls render() for the transcript.
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
  };
  // Claude's spark: still on a finished reply, turning while the agent works.
  const SPARK = '<svg class="spark" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.5l1.6 6.2 5.6-3.2-3.2 5.6 6.2 1.6-6.2 1.6 3.2 5.6-5.6-3.2L12 21.5l-1.6-6.2-5.6 3.2 3.2-5.6L1.8 12l6.2-1.6-3.2-5.6 5.6 3.2z"/></svg>';

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

  function diffHtml(old, neu) {
    const d = lineDiff(old, neu);
    const rows = d.rows.map(r => r.t === '…' ? '<div class="dl fold">⋯</div>' : `<div class="dl ${r.t === '+' ? 'add' : r.t === '-' ? 'del' : ''}"><i>${r.t === ' ' ? '' : r.t}</i>${escH(r.s) || ' '}</div>`).join('');
    return { html: `<div class="diff">${rows}</div>`, add: d.add, del: d.del };
  }
  function todoHtml(todos) {
    return '<ul class="todos">' + todos.map(t => `<li class="${escH(t.status)}">${t.status === 'completed' ? ICON.check : '<span class="box"></span>'}<span>${escH(t.text)}</span></li>`).join('') + '</ul>';
  }
  // One call: icon · verb · target · (+add −del), opening to its command/output, diff or plan.
  function toolRow(ev, done, cwd) {
    const c = toolCache.get(ev); if (c && c[0] === done) return c[1];
    const running = !done && !!ev.toolId, a = ev.args || {}, v = toolView(ev, running);
    const out = done && done.text ? done.text.replace(/\s+$/, '') : '';
    let body = '', stat = '';
    if (a.old != null || a.new != null) { const d = diffHtml(a.old, a.new); body = d.html; stat = `<span class="stat"><b class="add">+${d.add}</b> <b class="del">−${d.del}</b></span>`; if (done && done.err && out) body += `<pre class="out err">${escH(out)}</pre>`; }
    else if (a.todos) body = todoHtml(a.todos);
    else if (a.plan) body = `<div class="md sub">${md(a.plan, cwd)}</div>`;
    else if (v.kind === 'ask') body = (a.options || []).length ? '<ul class="opts">' + a.options.map(o => `<li>${escH(o)}</li>`).join('') + '</ul>' + (out && !done.err ? `<pre class="out">${escH(out)}</pre>` : '') : '';
    else if (v.kind === 'cmd') body = `<pre class="io"><span class="lbl">IN</span>${escH(a.command || '')}</pre>` + (out ? `<pre class="io${done.err ? ' err' : ''}"><span class="lbl">OUT</span>${escH(out)}</pre>` : '');
    else if (v.kind === 'agent' && out) body = `<div class="md sub">${md(out, cwd)}</div>`;
    else if (out) body = `<pre class="out${done.err ? ' err' : ''}">${escH(out)}</pre>`;
    const cls = `trow k-${v.kind}${running ? ' running' : ''}${done && done.err ? ' err' : ''}${ev.type === 'subtask' ? ' sub' : ''}`;
    const head = `${ICON[v.kind] || ICON.tool}<span class="verb">${escH(v.verb)}</span>${v.target ? `<span class="tgt${v.mono ? ' mono' : ''}" title="${escH(v.target)}">${escH(v.target)}</span>` : ''}${stat}`;
    const h = body ? `<details class="${cls}" data-tid="${escH(ev.toolId || '')}"><summary>${head}${ICON.chev}</summary><div class="tbody">${body}</div></details>` : `<div class="${cls}"><div class="sumrow">${head}</div></div>`;
    toolCache.set(ev, [done, h]);
    return h;
  }
  // A run of calls between two messages: one call shows as itself; more fold into a summary line, which names
  // the call still running so the line says what's happening now.
  function groupHtml(tools, doneBy, cwd) {
    const rows = tools.map(ev => toolRow(ev, doneBy.get(ev.toolId), cwd));
    if (tools.length === 1) return `<div class="tools">${rows[0]}</div>`;
    const live = [...tools].reverse().find(ev => ev.toolId && !doneBy.get(ev.toolId));
    const errs = tools.filter(ev => (doneBy.get(ev.toolId) || {}).err).length;
    const label = live ? (() => { const v = toolView(live, true); return `${escH(v.verb)} <span class="tgt mono">${escH(v.target)}</span>`; })() : escH(groupSummary(tools));
    return `<div class="tools"><details class="tgroup${live ? ' running' : ''}" data-tid="g:${escH(tools[0].toolId || '')}"><summary>${live ? '<span class="dot"></span>' : ''}<span class="gl">${label}</span>${errs ? `<span class="errs">${errs} failed</span>` : ''}${ICON.chev}</summary><div class="tlist">${rows.join('')}</div></details></div>`;
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
    else if (ev.type === 'interrupt') h = '<div class="msg note">Interrupted</div>';
    else h = '';
    if (mdReady || ev.type !== 'text') cache.set(ev, h);
    return h;
  }

  // The whole transcript. data-i on a reply is its index in evs, so Copy can fetch the raw markdown.
  function render(evs, doneBy, cwd) {
    let h = '', run = [];
    // Copy sits under each turn's last reply only, as in Claude's apps: narration between tool runs gets none.
    const finals = new Set(); let seen = false;
    for (let k = evs.length - 1; k >= 0; k--) { const t = evs[k].type; if (t === 'prompt' || t === 'command') seen = false; else if (t === 'text' && !seen) { finals.add(k); seen = true; } }
    const flush = () => { if (run.length) h += groupHtml(run, doneBy, cwd); run = []; };
    evs.forEach((ev, i) => {
      if (ev.type === 'tool' || ev.type === 'subtask') { run.push(ev); return; }
      if (ev.type === 'tool_done' || ev.type === 'turn') return;
      flush(); h += msgHtml(ev, i, cwd);
      if (finals.has(i)) h += `<div class="acts" data-i="${i}"><button class="act copy" type="button" title="Copy" aria-label="Copy">${ICON.copy}</button></div>`;
    });
    flush();
    return h;
  }

  // Clicks inside the view: copy a reply or a code block, expand a long prompt, follow links as the Docs column does.
  function onClick(e, a, evs) {
    const cwd = a && a.cwd;
    const key = e.target.closest('[data-key]'); // permission card: the same keys the terminal menu takes
    if (key && selectedId != null) { api.send({ type: 'termInput', id: selectedId, data: key.dataset.key === 'esc' ? '\x1b' : key.dataset.key + '\r' }); return; }
    const act = e.target.closest('[data-act]');
    if (act) { if (act.dataset.act === 'resume') resumeSelected(); else { switchTermTab('terminal'); const x = xterms.get(selectedId); if (x) x.terminal.focus(); } return; }
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
  // The live tail under the transcript: a permission card, the working line, a crash. st = agentStatus(a).
  function liveHtml(a, st) {
    const live = [...a.tools.values()].filter(t => !t.done), perm = live.find(t => t.perm);
    if (perm && perm.perm === 'ask') return `<div class="card ask"><div class="card-h">Claude has a question</div><p>${escH(perm.status || 'Waiting for your answer.')}</p><div class="btns"><button class="primary" type="button" data-act="answer">Answer</button></div></div>`;
    if (perm) return `<div class="card perm"><div class="card-h">Allow this action?</div><pre>${escH(perm.status || perm.name || '')}</pre><div class="btns"><button class="primary" type="button" data-key="1">Allow once</button><button type="button" data-key="2">Always allow</button><button type="button" data-key="esc">Deny</button></div></div>`;
    if (a.crashed === 'fatal') return `<div class="card err"><div class="card-h">The agent stopped</div><p>Process exited after ${a.crashCount}/${a.crashMax} attempts.</p><div class="btns"><button class="primary" type="button" data-act="resume">Resume</button></div></div>`;
    if (st === 'active' || st === 'resuming') { const t = live[live.length - 1]; return `<div class="working">${SPARK}<span class="shimmer">${escH(t ? 'Working…' : a.spinnerText || 'Thinking…')}</span></div>`; }
    return '';
  }
  // Draw the Chat view for agent a. Skips identical HTML (a text selection survives the live ticks), keeps open
  // tool rows and expanded prompts open, and follows the bottom unless you scrolled up.
  function paint(el, id, a, evs, st) {
    const doneBy = new Map(); if (evs) for (const ev of evs) if (ev.type === 'tool_done' && ev.toolId) doneBy.set(ev.toolId, ev);
    let h;
    if (!evs) h = '<div class="chat-empty"><span class="loading"></span></div>';
    else if (!evs.length) h = `<div class="chat-empty">${SPARK}<div>Ready when you are</div></div>`;
    else h = render(evs, doneBy, a.cwd);
    h += liveHtml(a, st);
    const busy = st === 'active' || st === 'resuming';
    document.getElementById('term-order').classList.toggle('busy', busy);
    const key = id + '|' + h; if (el._key === key) return; el._key = key;
    const same = el.dataset.for === String(id), stuck = same && el.scrollTop + el.clientHeight < el.scrollHeight - 40;
    const open = new Set([...el.querySelectorAll('details[open]')].map(d => d.dataset.tid)), more = new Set([...el.querySelectorAll('.bubble.open')].map(b => b.closest('[data-i]').dataset.i));
    el.innerHTML = h; el.dataset.for = String(id);
    if (same) { for (const d of el.querySelectorAll('details[data-tid]')) if (open.has(d.dataset.tid)) d.open = true; for (const b of el.querySelectorAll('.bubble.long')) if (more.has(b.closest('[data-i]').dataset.i)) { b.classList.add('open'); b.nextElementSibling.textContent = 'Show less'; } }
    if (!stuck) el.scrollTop = el.scrollHeight;
    syncJump(el);
  }
  // The round "jump to latest" button over the composer, shown while you're scrolled up.
  function syncJump(el) { const b = document.getElementById('chat-jump'); if (b) b.classList.toggle('show', el.scrollTop + el.clientHeight < el.scrollHeight - 200); }

  window.chatUi = { render, paint, onClick, syncJump, SPARK, onMdReady: (fn) => { rerender = fn; } };
})();
