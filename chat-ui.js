// Chat view: the agent's transcript drawn like Claude's desktop app. Replies in markdown, your prompts as bubbles,
// each run of tool calls folded into one line ("Ran 2 commands, read 3 files") that opens to the calls, and each call
// to its command + output or its diff. Fed by the timeline events (timeline-core.js); index.html's renderConversation
// hands over the agent and its status, this file draws the thread, the live tail (working line, plan, background
// agents, permission/question cards) and the composer's chips (mode, model, context).
(function () {
  const escH = escHtml; // chat-core.js
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
    diff: svg('<path d="M12 3v18"/><path d="M5 8h4M7 6v4"/><path d="M15 16h4"/><rect x="3" y="3" width="18" height="18" rx="2"/>'),
    artifact: svg('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18"/><path d="M7 6.5h.01M10 6.5h.01"/><path d="m10 13-2 2 2 2M14 13l2 2-2 2"/>'),
    trash: svg('<path d="M4 7h16"/><path d="M9 7V4h6v3"/><path d="M6 7l1 13h10l1-13"/>'),
    more: svg('<circle cx="5" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="19" cy="12" r="1.2"/>'),
    star: svg('<path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1 6.2L12 17.3 6.5 20.2l1-6.2L3 9.6l6.2-.9z"/>'),
    inbox: svg('<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.5 5h13L22 12v6a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-6z"/>'),
    fwd: svg('<path d="m15 5 6 6-6 6"/><path d="M21 11H9a6 6 0 0 0-6 6v2"/>'),
    undo: svg('<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>'),
    retry: svg('<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>'),
    alert: svg('<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/>'),
  };
  // Claude's spark: turning while the agent works, popping once when a turn lands.
  const SPARK = '<svg class="spark" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.5l1.6 6.2 5.6-3.2-3.2 5.6 6.2 1.6-6.2 1.6 3.2 5.6-5.6-3.2L12 21.5l-1.6-6.2-5.6 3.2 3.2-5.6L1.8 12l6.2-1.6-3.2-5.6 5.6 3.2z"/></svg>';
  const MODES = { bypassPermissions: ['Bypass permissions', 'bypass', 'Bypass'], acceptEdits: ['Accept edits', 'accept', 'Edits'], plan: ['Plan mode', 'plan', 'Plan'], auto: ['Auto mode', 'auto', 'Auto'], default: ['Ask first', 'ask', 'Ask'] };

  // Events never change once received, so each renders once; tool rows again when their result lands.
  // The text cache is dropped when md-bundle arrives (replies first render as plain text).
  let toolCache = new WeakMap(), groupCache = new WeakMap();
  let cache = new WeakMap(), mdReady = !!window.marked, mdLoading = false, rerender = () => {};
  function md(src, cwd) {
    if (!mdReady) {
      if (!mdLoading) mdLoading = true, window.docsUi.loadMd().then(() => { mdReady = true; cache = new WeakMap(); toolCache = new WeakMap(); groupCache = new WeakMap(); rerender(); }, () => {});
      return `<p class="plain">${inlineRich(escH(src))}</p>`;
    }
    return inlineRich(linkRefs(window.docsUi.toHtml(src, (cwd || '').replace(/\\/g, '/') + '/_')) // relative links resolve against the agent's folder
      // a bare claude.ai artifact URL reads as a short chip; the card drawn for it carries title and actions
      .replace(/(<a [^>]*href="(https:\/\/claude\.ai\/[^"]*artifact\/([\w-]+))"[^>]*)>\2<\/a>/g, (_, open, url, aid) => `${open.replace('<a ', '<a class="art-link" title="' + url + '" ')}>claude.ai · ${aid.slice(0, 8)}</a>`)
      // `C:\…\live-0.png` in a reply: the file's name and folder as a link (an image opens in the preview)
      .replace(/(?<!<pre>)<code>([^<]+)<\/code>/g, (m, t) => pathChip(t) || m));
  }
  // An absolute file path (already HTML-escaped) as a chip: name and folder, the full path on hover, opens on click.
  function pathChip(t) {
    const p = pathRef(t); if (!p) return '';
    const raw = p.file.replace(/&amp;/g, '&'), attr = escH(raw);
    return `<a class="fileref pathref${p.img ? ' img' : ''}" href="#" data-file="${attr}" data-line="0" title="${attr}">${p.img ? `<img src="${escH(fileUrl(raw))}" alt="" loading="lazy">` : ''}<span>${escH(p.name)}</span>${p.dir ? `<span class="pr-dir">${escH(p.dir)}</span>` : ''}</a>`;
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
  // A prompt as typed: its tags as chips, and a file path (quoted when it has spaces, as the box sends it) as a file chip.
  const PROMPT_PATH = /&quot;([A-Za-z]:[\\/][^&<\n]+?)&quot;|(?<![\w/])([A-Za-z]:[\\/][^\s&<]+)/g;
  // ── One inline renderer for every message, yours or Claude's: a link (named by prettyLinks: a ClickUp task, "repo #N",
  // a page's title), a file path as a file chip, [Image #N] as its picture, [Pasted text #N · …] as its chip, a /command
  // tagged. It works on HTML-escaped text and leaves what's inside a link, code, a button or a kbd alone. ──
  const imgChip = (n, own) => { const s = (own && own.get(n)) || tagSrc.get(n); return s ? `<button type="button" class="imgtag" data-src="${escH(s)}" title="Image #${n}"><img src="${escH(s)}" alt="">#${n}</button>` : `<span class="imgtag">${svg('<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="10" r="1.5"/><path d="m21 16-5-5-9 8"/>')}#${n}</span>`; };
  // The text is escaped: a quote or bracket after a link is an entity now, and ends it.
  const richText = (s, own) => s.replace(chatUrlRe('g'), (m) => { const k = m.search(/&(quot|#39|lt|gt);/), u = k < 0 ? m : m.slice(0, k); return /^https?:\/\/./.test(u) ? `<a href="${u}">${u}</a>` + m.slice(u.length) : m; })
    .replace(PROMPT_PATH, (m, q, u) => pathChip(q || u) || m)
    .replace(/(^|\s)(\/[a-z][\w:-]*)(?=\s|$)/g, '$1<span class="cmdtag">$2</span>')
    .replace(/\[Pasted text #(\d+) · (\d+) lines\]/g, (_, k, n) => `<button type="button" class="imgtag" data-pn="${k}">¶ Pasted text · ${n} lines</button>`)
    .replace(/\[Image #(\d+)\]/g, (_, n) => imgChip(n, own));
  function inlineRich(html, own) {
    let depth = 0; // inside <a>, <code>, <pre>, <button>, <kbd>: left as it is
    return html.split(/(<[^>]+>)/).map(p => {
      if (p[0] === '<') { const m = /^<(\/?)(a|code|pre|button|kbd)\b/i.exec(p); if (m) depth = Math.max(0, depth + (m[1] ? -1 : 1)); return p; }
      return depth || !p ? p : richText(p, own);
    }).join('');
  }
  const tagChips = (text, own) => inlineRich(escH(text), own);
  // When a usage limit resets: "…|1761580800" (epoch seconds) or "resets 6pm" / "resets at 18:30" (the next such time).
  function resetOf(ev) {
    const t = String(ev.text || ''), ep = /\|(\d{10})\b/.exec(t); if (ep) return +ep[1] * 1000;
    const m = /resets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i.exec(t); if (!m) return 0;
    let h = +m[1] % 24; if (m[3]) h = (h % 12) + (/pm/i.test(m[3]) ? 12 : 0);
    const base = ev.ts ? new Date(ev.ts) : new Date(), d = new Date(base); d.setHours(h, +(m[2] || 0), 0, 0);
    if (d <= base) d.setDate(d.getDate() + 1);
    return d.getTime();
  }
  const autoRetry = new Set(); let retryTimer = null; // "agentId:resetTime" the user asked to retry at
  const dur = (ms) => { const s = Math.round(ms / 1000); return s < 60 ? s + 's' : s < 3600 ? Math.floor(s / 60) + 'm ' + (s % 60) + 's' : Math.floor(s / 3600) + 'h ' + Math.floor(s % 3600 / 60) + 'm'; };
  const clocks = new Map(); // formatting a time is slow, and every footer shows one on every redraw
  const clock = (ts) => { let c = clocks.get(ts); if (c == null) { try { c = new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); } catch { c = ''; } clocks.set(ts, c); } return c; };

  function diffHtml(old, neu, file) {
    const d = lineDiff(old, neu);
    return { html: rowsHtml(d.rows, file), add: d.add, del: d.del };
  }
  // Diff rows, each line coloured by the file's language (line by line: cheap, and right for almost every line).
  const LANG = { js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript', json: 'json', css: 'css', scss: 'css', html: 'xml', xml: 'xml', vue: 'xml', svg: 'xml', md: 'markdown', py: 'python', sh: 'bash', ps1: 'powershell', yml: 'yaml', yaml: 'yaml', sql: 'sql', go: 'go', rs: 'rust', java: 'java', cs: 'csharp', c: 'c', h: 'c', cpp: 'cpp', ini: 'ini' };
  function rowsHtml(rows, file) {
    const ext = String(file || '').split('.').pop().toLowerCase(), lang = LANG[ext], hl = lang && window.hljs && hljs.getLanguage(lang);
    const line = (s) => { if (!s) return ' '; if (hl) try { return hljs.highlight(s, { language: lang, ignoreIllegals: true }).value; } catch {} return escH(s); };
    // Rows from git carry line numbers, old and new in two columns (a removed line has only the old, an added one only
    // the new), and hunk headers (a fold row: git's "@@ -1,3 +1,3 @@" and its context, e.g. "function foo()").
    const nums = rows.some(r => r.n != null || r.o != null);
    const ln = (r) => nums ? (r.t === '…' ? '<em class="ln"></em><em class="ln"></em>' : `<em class="ln">${r.o ?? ''}</em><em class="ln">${r.n ?? ''}</em>`) : '';
    return `<div class="diff${nums ? ' numbered' : ''}">${rows.map(r => r.t === '…' ? `<div class="dl fold">${ln(r)}<i></i><span>${r.s ? escH(r.s) : '⋯'}</span></div>` : `<div class="dl ${r.t === '+' ? 'add' : r.t === '-' ? 'del' : ''}">${ln(r)}<i>${r.t === ' ' ? '' : r.t}</i><span>${line(r.s)}</span></div>`).join('')}</div>`;
  }
  // file:line references in a reply become links: click opens the file at that line, hover peeks at it. Only text
  // outside tags is touched, and nothing inside code blocks or existing links.
  function linkRefs(html) {
    let skip = 0;
    return html.split(/(<[^>]+>)/).map(seg => {
      if (seg[0] === '<') { if (/^<(pre|a)[\s>]/i.test(seg)) skip++; else if (/^<\/(pre|a)>/i.test(seg)) skip = Math.max(0, skip - 1); return seg; }
      if (skip || !/:\d/.test(seg)) return seg;
      const refs = fileRefs(seg); if (!refs.length) return seg;
      let out = '', at = 0;
      for (const r of refs) {
        const txt = seg.slice(r.index, r.index + r.length);
        out += seg.slice(at, r.index) + `<a class="fileref" href="#" data-file="${r.file.replace(/"/g, '&quot;')}" data-line="${r.line}">${txt}</a>`; at = r.index + r.length;
      }
      return out + seg.slice(at);
    }).join('');
  }
  // The card for a published Artifact: its icon word, title, description and claude.ai link. Open goes to the browser,
  // where you're signed in to claude.ai (the page is private to your account, so it can't be embedded here).
  function artifactCard(ev, url) {
    const a = ev.args || {}, title = a.title || baseName(a.file_path) || 'Artifact', id = url.split('/').pop();
    return `<div class="art-card" data-tid="${escH(ev.toolId)}"><div class="ac-ic">${ICON.artifact}</div><div class="ac-t"><b>${escH(title)}</b>${a.description ? `<small>${escH(a.description)}</small>` : ''}<span class="ac-u">claude.ai · ${escH(id.slice(0, 8))}</span></div><div class="ac-b"><button type="button" class="primary" data-art-open="${escH(url)}">Open</button><button type="button" class="ic-only" data-art-copy="${escH(url)}" title="Copy link" aria-label="Copy link">${ICON.copy}</button></div></div>`;
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
    if (a.old != null || a.new != null) { const d = diffHtml(a.old, a.new, a.file_path); body = d.html; stat = `<span class="stat"><b class="add">+${d.add}</b> <b class="del">−${d.del}</b></span>`; if (err && out) body += `<pre class="out">${escH(out)}</pre>`; }
    else if (a.todos) body = `<div class="plan-card past">${todoHtml(a.todos)}</div>`; // the live plan card's frame, without its bar
    else if (a.plan) body = `<div class="md sub plan">${md(a.plan.replace(/^#{1,6}\s*plan\s*\n+/i, ''), cwd)}</div>`;
    else if (v.kind === 'ask') body = (a.options || []).length ? '<ul class="opts">' + a.options.map(o => `<li>${escH(o.label ?? o)}</li>`).join('') + '</ul>' + (out && !err ? `<div class="answer">${escH(out)}</div>` : '') : '';
    else if (v.kind === 'cmd') body = `<div class="io${err ? ' err' : ''}"><div class="io-r"><span class="lbl">IN</span><pre>${escH(a.command || '')}</pre></div>${out ? `<div class="io-r"><span class="lbl">OUT</span><pre>${escH(out)}</pre></div>` : ''}</div>`;
    else if (out) body = `<pre class="out${err ? ' err' : ''}">${escH(out)}</pre>`;
    const cls = `trow k-${v.kind}${running ? ' running' : ''}${err ? ' err' : ''}${ev.type === 'subtask' ? ' sub' : ''}`;
    const head = `${ICON[v.kind] || ICON.tool}<span class="verb">${escH(v.verb)}</span>${v.target ? `<span class="tgt${v.mono ? ' mono' : ''}" title="${escH(v.target)}">${escH(v.target)}</span>` : ''}${stat}${running && ev.ts ? `<span class="el" data-t="${Date.parse(ev.ts)}"></span>` : ''}`;
    const h = v.kind === 'agent' ? `<div class="${cls}" data-agent-tid="${escH(ev.toolId || '')}" role="button" tabindex="0" title="Show its steps"><div class="sumrow">${head}${ICON.chev}</div></div>`
      : body ? `<details class="${cls}" data-tid="${escH(ev.toolId || '')}"><summary>${head}${ICON.chev}</summary><div class="tbody">${body}</div></details>` : `<div class="${cls}"><div class="sumrow">${head}</div></div>`;
    toolCache.set(ev, [done, h]);
    return h;
  }
  // A run of calls between two messages: one call shows as itself; more fold into one summary line.
  function groupHtml(tools, doneBy, cwd) {
    const gc = groupCache.get(tools[0]); if (gc && gc[0] === tools.length && gc[1] === cwd) return gc[2]; // a finished run never changes
    const rows = tools.map(ev => toolRow(ev, doneBy.get(ev.toolId), cwd));
    const done = (h) => { if (tools.every(ev => !ev.toolId || doneBy.get(ev.toolId))) groupCache.set(tools[0], [tools.length, cwd, h]); return h; };
    if (tools.length === 1) return done(`<div class="tools">${rows[0]}</div>`);
    const errs = tools.filter(ev => (doneBy.get(ev.toolId) || {}).err).length;
    // While a call runs the line names it ("Running npm test"), with a dot; once all are done, the summary.
    const live = [...tools].reverse().find(ev => ev.toolId && !doneBy.get(ev.toolId)), lv = live && toolView(live, true);
    const label = lv ? `${escH(lv.verb)}${lv.target ? ` <span class="mono">${escH(lv.target)}</span>` : ''}` : escH(groupSummary(tools));
    return done(`<div class="tools"><details class="tgroup${live ? ' running' : ''}" data-tid="g:${escH(tools[0].toolId || '')}"><summary>${live ? '<span class="dot"></span>' : ''}<span class="gl">${label}</span><span class="gl gs">${tools.length} actions</span>${errs ? `<span class="errs">${errs} failed</span>` : ''}${ICON.chev}</summary><div class="tlist">${rows.join('')}</div></details></div>`);
  }

  function msgHtml(ev, i, cwd) {
    const c = cache.get(ev); if (c && c[0] === i) return c[1]; // data-i is in the html: an event that moved (hidden ones, the list trimmed) redraws
    let h;
    if (ev.type === 'images') h = `<div class="msg user imgs-only"><div class="imgs">${ev.paths.map(p => `<img src="${escH(fileUrl(p))}" alt="" loading="lazy">`).join('')}</div></div>`;
    else if (ev.type === 'prompt') {
      // Embedded images first; an image too big to embed shows from its file, via the path Claude Code wrote.
      const srcs = promptSrcs(ev);
      const text = (ev.text || '').trim(), nums = tagNums(text);
      const imgs = thumbs(srcs, nums);
      const long = text.length > 900 || text.split('\n').length > 14;
      h = `<div class="msg user" data-i="${i}">${imgs ? `<div class="imgs">${imgs}</div>` : ''}${text ? `<div class="bubble${long ? ' long' : ''}">${tagChips(text)}</div>${long ? '<button class="more" type="button">Show more</button>' : ''}` : ''}</div>`;
    } else if (ev.type === 'text') h = `<div class="msg ai" data-i="${i}"><div class="md">${md(ev.text, cwd)}</div></div>`;
    // A /command (a skill, /compact…) is something you sent: your message bubble, the command tinted as in the reply box.
    else if (ev.type === 'command') h = `<div class="msg user" data-i="${i}"><div class="bubble">${tagChips(ev.text)}</div></div>`;
    else if (ev.type === 'interrupt') h = '<div class="msg note">⎿ Interrupted</div>';
    else if (ev.type === 'compact') h = '<div class="msg divider"><span>Conversation compacted</span></div>';
    else if (ev.type === 'peer') h = `<details class="msg peer" data-i="${i}"><summary>${ICON.agent}<span class="pr-from">${escH(ev.from)}</span><span class="pr-sum">${escH(ev.summary || ev.text.split('\n')[0])}</span>${ICON.chev}</summary><div class="md sub">${md(ev.text, cwd)}</div></details>`; // another session's note
    else if (ev.type === 'resumed') h = `<div class="msg divider"><span>${escH(String(ev.text || '').replace(/^Your /, ''))} · resumed</span></div>`;
    else if (ev.type === 'apierror' && /limit|rate/i.test(ev.kind + ' ' + ev.text) && resetOf(ev)) {
      // A usage limit with a known reset: when it resets and how long until, Retry waits for it, or retry by itself then.
      const at = resetOf(ev), msg = String(ev.text).replace(/\|\d{10}\b/, '').trim();
      h = `<div class="msg apierr" data-i="${i}"><div class="card err" role="alert"><div class="card-h">${ICON.alert}<span>Usage limit reached</span></div><p>${escH(msg)}</p><p class="reset">Resets ${escH(clock(new Date(at).toISOString()))} · <span class="countdown" data-reset="${at}"></span></p><div class="btns"><button type="button" data-act="retry" data-reset="${at}">Retry</button><label class="auto"><input type="checkbox" data-autoretry="${at}"> Retry when it resets</label></div></div></div>`;
    }
    else if (ev.type === 'apierror') { // overload, login trouble: a card that says so, with Retry
      const limit = /limit|rate/i.test(ev.kind + ' ' + ev.text);
      h = `<div class="msg apierr" data-i="${i}"><div class="card err" role="alert">${'<div class="card-h">' + ICON.alert}<span>${limit ? 'Usage limit reached' : 'Request failed'}</span></div><p>${escH(ev.text)}</p><div class="btns"><button type="button" data-act="retry">Retry</button></div></div></div>`;
    }
    else h = '';
    if (mdReady || ev.type !== 'text') cache.set(ev, [i, h]);
    return h;
  }
  // Under a finished turn: copy its last reply · how long it worked · when it finished — the CLI's "Cogitated for 42s".
  // Also what the turn changed ("3 files · +42 −10", click opens those edits) and what it cost ("$0.42 · ↓ 18k").
  const famOf = (m) => /opus/i.test(m) ? 'opus' : /haiku/i.test(m) ? 'haiku' : /fable|mythos/i.test(m) ? 'fable' : 'sonnet';
  const diffCache = new WeakMap();
  const editStat = (ev) => { let d = diffCache.get(ev); if (!d) { d = lineDiff(ev.args.old, ev.args.new); diffCache.set(ev, d); } return d; };
  // An edit Undo can put back exactly: an Edit whose texts weren't cut short and that didn't delete outright
  // (a Write or MultiEdit has no exact way back).
  const undoable = (ev) => ev.name === 'Edit' && ev.args.new && ![ev.args.old, ev.args.new].some(s => s.length > 5000 && s.endsWith('…'));
  function undoTurn(evs, from, to, a) {
    const done = new Map(evs.filter(e => e.type === 'tool_done').map(e => [e.toolId, e]));
    const eds = evs.slice(from, to + 1).filter(e => e.type === 'tool' && e.args && (e.args.old != null || e.args.new != null) && done.get(e.toolId) && !done.get(e.toolId).err);
    if (!eds.length || !eds.every(undoable)) return;
    const files = new Set(eds.map(e => e.args.file_path));
    showConfirm(`Undo this turn's ${eds.length} edit${eds.length > 1 ? 's' : ''} in ${files.size} file${files.size > 1 ? 's' : ''}?`, 'Undo edits').then(ok => {
      if (ok) api.send({ type: 'undoTurn', id: selectedId, cwd: a && a.cwd, edits: eds.map(e => ({ file: e.args.file_path, old: e.args.old, new: e.args.new, all: !!e.args.all })) });
    });
  }
  // Claude ended by asking you something: its choices (or Yes / No) as one-click answers under the reply.
  function qrHtml(evs) {
    for (let k = evs.length - 1; k >= 0; k--) {
      const t = evs[k].type; if (t === 'turn' || t === 'mode' || t === 'tool_done' || t === 'images' || t === 'bgdone' || t === 'queue') continue;
      if (t !== 'text') return '';
      const o = quickReplies(evs[k].text); return o.length ? `<div class="qreplies">${o.map(x => `<button type="button" class="qr" data-qr="${escH(x)}">${escH(x)}</button>`).join('')}</div>` : '';
    }
    return '';
  }
  function footHtml(textAt, turn, sum, mark) {
    const meta = turn ? `<span class="tf-meta">${SPARK}${Number.isFinite(turn.ms) && turn.ms > 0 ? 'Worked ' + escH(dur(turn.ms)) : 'Done'}${turn.ts ? ' · ' + escH(clock(turn.ts)) : ''}</span>` : ''; // a turn without its duration says Done, not "NaNh"
    let files = '', cost = '';
    if (sum && sum.files.size) files = `<button type="button" class="tf-files" data-act="turn-edits" data-from="${sum.from}" data-to="${sum.to}" title="Show this turn's edits">${ICON.edit}${sum.files.size} file${sum.files.size > 1 ? 's' : ''} <b class="add">+${sum.add}</b> <b class="del">−${sum.del}</b></button>`;
    if (sum && sum.o && typeof calcCost === 'function') { const c = calcCost({ modelFamily: famOf(sum.m), inTok: sum.i + sum.cr + sum.cw, outTok: sum.o, cacheTok: sum.cw, cacheRead: sum.cr }); cost = `<span class="tf-cost" title="This turn's cost and tokens written">${escH(fmtCost(c))} · ↓ ${escH(sum.o >= 1000 ? (sum.o / 1000).toFixed(1) + 'k' : String(sum.o))}</span>`; }
    // What happened first (always in the same place), then the actions, which hide on older turns until hovered.
    const acts = (textAt >= 0 ? `<button class="act copy" type="button" title="Copy reply" aria-label="Copy reply">${ICON.copy}</button><button class="act" type="button" data-act="fwd" title="Send to another agent" aria-label="Send to another agent">${ICON.fwd}</button>` : '') + (sum && sum.files.size && sum.undo ? `<button class="act" type="button" data-act="undo-turn" data-from="${sum.from}" data-to="${sum.to}" title="Undo this turn's edits" aria-label="Undo this turn's edits">${ICON.undo}</button>` : '') + (mark && mark.ts ? `<button class="act mark${mark.on ? ' on' : ''}" type="button" data-act="mark" data-ts="${escH(mark.ts)}" title="${mark.on ? 'Remove bookmark' : 'Bookmark this reply'}" aria-label="${mark.on ? 'Remove bookmark' : 'Bookmark this reply'}" aria-pressed="${mark.on}">${ICON.star}</button>` : '');
    return `<div class="turnfoot"${textAt >= 0 ? ` data-i="${textAt}"` : ''}>${meta}${files}${cost}${acts ? `<span class="tf-acts">${acts}</span>` : ''}</div>`;
  }

  // The transcript as blocks (one per message, tool run or turn footer), so paint can swap only what changed.
  // A turn's footer waits until the turn is over: its turn_duration line, or the next prompt.
  // A long session shows its last 10 turns; the ones before fold into one line ("Earlier: 14 turns · 38 files · $4.10")
  // that opens them all.
  // Bookmarks: a reply you star stays on the prompt rail for this session (kept per session, in this browser).
  const markKey = (id) => { const a = agents.get(id); return (a && a.sessionId) || String(id); };
  const allMarks = (() => { try { return JSON.parse(localStorage.getItem('chatMarks') || '{}'); } catch { return {}; } })();
  const marksOf = (id) => new Set(allMarks[markKey(id)] || []);
  function toggleMark(ts) { const k = markKey(selectedId), m = marksOf(selectedId); m.has(ts) ? m.delete(ts) : m.add(ts); allMarks[k] = [...m]; try { localStorage.setItem('chatMarks', JSON.stringify(allMarks)); } catch {} rerender(); }
  const KEEP_TURNS = 10;
  const expanded = new Set(); // agent ids whose earlier turns are open
  function blocks(evs, doneBy, cwd, id) {
    const out = []; let run = [], textAt = -1, turn = null, open = false, lastPrompt = null, lastPromptAt = -1;
    // The CLI writes one record per block of a reply, each with the whole reply's usage: count each reply once.
    const seenU = new Set(), once = (e) => e.u && !(e.u.id && (seenU.has(e.u.id) || !seenU.add(e.u.id)));
    const promptsAt = []; evs.forEach((e, k) => { if (e.type === 'prompt') promptsAt.push(k); });
    let start = 0;
    if (!expanded.has(id) && promptsAt.length > KEEP_TURNS + 2) {
      start = promptsAt[promptsAt.length - KEEP_TURNS];
      const files = new Set(); let o = 0, cost = 0, m = '';
      const u = { i: 0, o: 0, cr: 0, cw: 0 };
      for (let k = 0; k < start; k++) { const e = evs[k]; if (once(e)) { u.i += e.u.i; u.o += e.u.o; u.cr += e.u.cr; u.cw += e.u.cw; if (e.u.m && e.u.m !== '<synthetic>') m = e.u.m; } if (e.type === 'tool' && e.args && (e.args.old != null || e.args.new != null)) files.add(e.args.file_path || '?'); }
      if (u.o && typeof calcCost === 'function') cost = calcCost({ modelFamily: famOf(m), inTok: u.i + u.cr + u.cw, outTok: u.o, cacheTok: u.cw, cacheRead: u.cr });
      const n = promptsAt.filter(k => k < start).length;
      out.push(`<button type="button" class="earlier" data-act="expand-earlier">${ICON.chev}<span>Earlier: ${n} turn${n > 1 ? 's' : ''}${files.size ? ` · ${files.size} file${files.size > 1 ? 's' : ''}` : ''}${cost ? ` · ${escH(fmtCost(cost))}` : ''}</span></button>`);
    }
    const fresh = () => ({ files: new Set(), add: 0, del: 0, i: 0, o: 0, cr: 0, cw: 0, m: '', from: -1, to: -1, undo: true });
    let sum = fresh();
    const tally = (ev, i) => {
      if (once(ev)) { sum.i += ev.u.i; sum.o += ev.u.o; sum.cr += ev.u.cr; sum.cw += ev.u.cw; if (ev.u.m && ev.u.m !== '<synthetic>') sum.m = ev.u.m; }
      if (ev.type === 'tool' && ev.args && (ev.args.old != null || ev.args.new != null) && doneBy.get(ev.toolId) && !doneBy.get(ev.toolId).err) {
        const d = editStat(ev); sum.files.add(ev.args.file_path || ev.args.notebook_path || '?'); sum.add += d.add; sum.del += d.del;
        if (sum.from < 0) sum.from = i; sum.to = i;
        if (!undoable(ev)) sum.undo = false;
      }
    };
    for (let k = evs.length - 1; k >= 0; k--) if (evs[k].type === 'prompt' || evs[k].type === 'command') { lastPromptAt = k; break; }
    // This agent's image numbers → pictures, so a later [Image #N] can show the image it means.
    tagSrc.clear(); for (const ev of evs) if (ev.type === 'prompt') { const ns = tagNums(ev.text); promptSrcs(ev).forEach((src, k) => { if (ns[k]) tagSrc.set(ns[k], src); }); }
    const flush = () => { if (run.length) out.push(groupHtml(run, doneBy, cwd)); run = []; };
    // Only a finished turn gets a footer: a message typed mid-turn doesn't end the turn.
    const mk = marksOf(id);
    const close = () => { flush(); if (!turn) return; if (open) out.push(footHtml(textAt, turn, sum, textAt >= 0 && evs[textAt].ts ? { ts: evs[textAt].ts, on: mk.has(evs[textAt].ts) } : null)); textAt = -1; turn = null; open = false; sum = fresh(); };
    evs.forEach((ev, i) => {
      if (i < start) return;
      const t = ev.type;
      tally(ev, i);
      if (t === 'tool' && (ev.name === 'AskUserQuestion' || ev.name === 'ExitPlanMode') && !doneBy.get(ev.toolId)) return; // its card shows it
      // A published Artifact stands on its own as a card (title, what it is, its link), not as a row in a run of calls.
      if (t === 'tool' && ev.name === 'Artifact' && doneBy.get(ev.toolId) && doneBy.get(ev.toolId).artifactUrl) { flush(); out.push(artifactCard(ev, doneBy.get(ev.toolId).artifactUrl)); open = true; return; }
      if (t === 'tool' || t === 'subtask') { run.push(ev); open = true; return; }
      if (t === 'tool_done' || t === 'mode' || t === 'bgdone' || t === 'queue') return;
      // The "[Image: source: …]" record after a prompt: only shown when that prompt had no thumbnails of its own.
      if (t === 'images') { if (lastPrompt && ((lastPrompt.images || []).length || (lastPrompt.paths || []).length)) return; }
      if (t === 'prompt') lastPrompt = ev;
      if (t === 'turn') { turn = ev; return; }
      if (t === 'interrupt') { flush(); textAt = -1; open = false; sum = fresh(); } // a stopped turn gets no footer; the next one counts afresh
      if (t === 'prompt' || t === 'command') close();
      // Being edited: the bubble is the editor (the same html every redraw, so typing isn't lost).
      if ((t === 'prompt' || t === 'command') && editing && editing.id === id && editing.i === i) { flush(); out.push(`<div class="msg user editing" data-i="${i}"><textarea class="edit-ta" rows="2" aria-label="Edit your message">${escH(editing.text)}</textarea><div class="edit-btns"><button type="button" data-act="edit-cancel">Cancel</button><button type="button" class="primary" data-act="edit-send">Send</button></div></div>`); return; }
      flush(); out.push(msgHtml(ev, i, cwd));
      if (t === 'text') { textAt = i; open = true; }
      // Your last prompt: Edit puts it back in the box, Retry sends it again.
      // Any message of yours: Edit (rewinds to it), send it to another agent; the last one also Retry. An earlier
      // version is only to read.
      if ((t === 'prompt' || t === 'command') && ev.text && ev._ver == null) out.push(`<div class="uacts" data-i="${i}"><button type="button" class="act" data-act="edit-prompt" title="Edit">${ICON.edit}</button><button type="button" class="act" data-act="fwd" title="Send to another agent">${ICON.fwd}</button>${i === lastPromptAt ? `<button type="button" class="act" data-act="retry" title="Send again">${ICON.retry}</button>` : ''}</div>`);
      // A message with earlier versions: ‹ 1/2 › switches which one the thread shows from here on.
      if ((t === 'prompt' || t === 'command') && ev.alts && ev.alts.length) { const n = ev.alts.length + 1, k = ev._ver != null ? ev._ver + 1 : n; out.push(`<div class="vers" data-i="${i}"><button type="button" class="act" data-act="ver" data-d="-1" aria-label="Earlier version"${k > 1 ? '' : ' disabled'}>‹</button><span>${k}/${n}</span><button type="button" class="act" data-act="ver" data-d="1" aria-label="Later version"${k < n ? '' : ' disabled'}>›</button></div>`); }
    });
    flush(); if (turn) close();
    for (let k = out.length - 1; k >= 0; k--) if (out[k].startsWith('<div class="turnfoot"')) { out[k] = out[k].replace('<div class="turnfoot"', '<div class="turnfoot latest"'); break; }
    return out;
  }

  // ── Editing a sent message, as in the Claude app: the bubble becomes an editor; Send stops the turn if it's running,
  // rewinds the CLI to before that message (keeping the code as it is), and sends the new text in its place. The old
  // message and everything after it are hidden from the thread from then on (the transcript keeps every branch). ──
  let editing = null; // { id, i, ts, text } while a bubble is being edited
  const hideKey = (a) => a && a.sessionId ? 'chatHide:' + a.sessionId : null;
  // Overlord keeps them with the agent (they outlive this window's storage); this window's copy covers the moment before main answers.
  const hidesOf = (a) => { if (Array.isArray(a && a.chatHides) && a.chatHides.length) return a.chatHides; try { return JSON.parse(localStorage.getItem(hideKey(a)) || '[]'); } catch { return []; } };
  const setHides = (a, rs) => { a.chatHides = rs; try { localStorage.setItem(hideKey(a), JSON.stringify(rs)); } catch {} api.send({ type: 'chatHides', id: [...agents].find(([, x]) => x === a)?.[0], hides: rs }); };
  // From a hidden prompt to the next prompt sent after the edit: every event in between goes.
  // An earlier version on view: the thread from that message on is that branch (read-only; the CLI is on the latest).
  const verView = new Map(), altEvs = new WeakMap(); // agent id → { ts, k } · a branch → its events, the first one versioned
  function viewEvs(a, evs) {
    const v = visibleEvs(a, evs), vv = verView.get(selectedId); if (!vv) return v;
    const at = v.findIndex(e => e.ts === vv.ts && e.alts && e.alts[vv.k]); if (at < 0) { verView.delete(selectedId); return v; }
    const alt = v[at].alts[vv.k];
    if (!altEvs.has(alt)) altEvs.set(alt, [{ ...alt[0], alts: v[at].alts, _ver: vv.k, _ts: vv.ts }, ...alt.slice(1)]);
    return v.slice(0, at).concat(altEvs.get(alt));
  }
  function visibleEvs(a, evs) {
    const rs = hideKey(a) ? hidesOf(a) : []; if (!rs.length) return evs;
    let hide = false;
    return evs.filter(e => {
      if ((e.type === 'prompt' || e.type === 'command') && e.ts) { const t = Date.parse(e.ts); hide = rs.some(r => t >= r.from && t < r.until); }
      return !hide;
    });
  }
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  async function until(fn, ms = 4000) { for (let t = 0; t < ms; t += 150) { const v = fn(); if (v) return v; await wait(150); } return null; }
  async function editResend(ev, text) {
    const id = selectedId, a = agents.get(id), k = hideKey(a); if (!a || !text) return;
    const range = { from: Date.parse(ev.ts), until: Date.now() };
    const save = (rs) => setHides(a, rs);
    // Which of the CLI's rewind entries it is: the same words sent again later sit below it in that list.
    const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase(), head = norm(ev.text).slice(0, 30);
    const same = (s) => { const l = norm(s); return !!l && !!head && (l.startsWith(head.slice(0, l.length)) || head.startsWith(l.replace(/…$/, ''))); };
    const all = visibleEvs(a, (worldTl && worldTl.id === id && worldTl.events) || []), at = all.indexOf(ev);
    let later = at < 0 ? 0 : all.slice(at + 1).filter(e => (e.type === 'prompt' || e.type === 'command') && same(e.text)).length;
    save([...hidesOf(a), range]); chatUi.addPending(id, text); rerender();
    const busy = () => isWorkingStatus(agents.get(id)?.status) || document.getElementById('term-order').classList.contains('busy');
    if (busy()) { stop(false); await until(() => !busy(), 10000); await wait(600); }
    // Esc Esc opens the rewind list; pick this message (the newest one with its text), then "Restore conversation".
    const fail = (why) => { save(hidesOf(a).filter(r => r.from !== range.from || r.until !== range.until)); api.send({ type: 'termInput', id, data: '\x1b' }); setTimeout(() => chatComposer.sendText(id, text), 400); showToast(why + ': sent as a new message'); rerender(); };
    api.send({ type: 'termInput', id, data: '\x1b' }); await wait(150); api.send({ type: 'termInput', id, data: '\x1b' });
    let rw = await until(() => screenRewind(id)); if (!rw) return fail("Couldn't open rewind");
    // On screen already: straight to it. Else up from "(current)" one entry at a time (the list scrolls), past `later`
    // entries with the same words.
    let j = -1; for (let q = rw.items.length - 1, n = later; q >= 0; q--) if (same(rw.items[q].label) && n-- === 0) { j = q; break; }
    if (j >= 0) { for (const k of arrowKeys(j - rw.focus)) { api.send({ type: 'termInput', id, data: k }); await wait(70); } }
    else for (let step = 0, stuck = 0, sig = ''; ; step++) {
      const it = rw.items[rw.focus];
      if (it && same(it.label) && later-- === 0) break;
      const s = rw.focus + '|' + (it && it.label);
      if (step > 200 || (s === sig && ++stuck > 4)) return fail("Couldn't find that message");
      if (s !== sig) { sig = s; stuck = 0; }
      api.send({ type: 'termInput', id, data: '\x1b[A' }); await wait(90);
      rw = screenRewind(id) || rw;
    }
    api.send({ type: 'termInput', id, data: '\r' });
    const sa = await until(() => { const s = screenAsk(id); return s.dialog && s.options.length >= 2 ? s : null; });
    if (!sa) return fail("Rewind didn't ask what to restore");
    let o = sa.options.findIndex(x => /^restore conversation$/i.test(x.label.trim()));
    if (o < 0) o = sa.options.findIndex(x => /conversation/i.test(x.label) && !/code/i.test(x.label));
    if (o < 0 || o > 8) return fail("Rewind offered no conversation restore");
    api.send({ type: 'termInput', id, data: String(o + 1) });
    if (!(await until(() => !screenAsk(id).dialog && !screenRewind(id), 3000))) return fail("Rewind didn't finish"); // never paste into its menu
    await wait(300);
    // The CLI puts the old message back in its box: clear it (the agent is idle), then send the new one.
    chatComposer.sendText(id, text);
  }

  // In the editor: Enter sends, Shift+Enter is a new line, Esc cancels; it grows with its text.
  document.getElementById('conversation').addEventListener('keydown', (e) => {
    if (!e.target.matches || !e.target.matches('.edit-ta')) return;
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); e.target.closest('.msg').querySelector('[data-act="edit-send"]').click(); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); e.target.closest('.msg').querySelector('[data-act="edit-cancel"]').click(); }
  });
  document.getElementById('conversation').addEventListener('input', (e) => { if (e.target.matches && e.target.matches('.edit-ta')) { e.target.style.height = 'auto'; e.target.style.height = e.target.scrollHeight + 'px'; } });
  // ── Live tail: what the CLI shows under the transcript ──
  const lastTool = (evs, name, doneBy) => { for (let k = evs.length - 1; k >= 0; k--) { const e = evs[k]; if (e.type === 'tool' && e.name === name) return doneBy && doneBy.get(e.toolId) ? null : e; if (e.type === 'prompt') return null; } return null; };
  // What's being approved, as the terminal shows it: an edit's diff, a command in full, a new file's content.
  function permHtml(perm, evs, doneBy) {
    const n = perm.name || '', title = n === 'Bash' || n === 'PowerShell' ? 'Run this command?' : /^(Edit|Write|MultiEdit|NotebookEdit)$/.test(n) ? 'Make this edit?' : /^Web/.test(n) ? 'Fetch this page?' : `Allow ${escH(n.replace(/^mcp__[^_]+__/, '')) || 'this action'}?`;
    const kind = toolView({ name: n }).kind, ev = lastTool(evs, n, doneBy), a = (ev && ev.args) || {};
    let what = `<pre>${escH(perm.status || n)}</pre>`;
    // The call isn't in the transcript until it's answered: what the CLI shows above its question is what's asked
    // ("Edit file / hello.txt / the change", "Bash command / git push"), and its question is the card's title.
    const sp = !ev && screenPerm(selectedId);
    if (sp) return `<div class="card perm"><div class="card-h">${ICON[toolView({ name: /^bash|command/i.test(sp.body[0] || '') ? 'Bash' : /edit|write|create/i.test(sp.question) ? 'Edit' : '' }).kind] || ICON.shield}<span>${escH(sp.question)}</span></div>${sp.body.length ? `<pre class="perm-screen">${escH(sp.body.join('\n'))}</pre>` : ''}<div class="btns">${permBtns(selectedId, 'data-keys', true)}</div></div>`;
    if (a.old != null || a.new != null) what = `<div class="perm-file">${ICON.edit}<span class="mono">${escH(a.file_path || '')}</span></div>${diffHtml(a.old, a.new, a.file_path).html}`;
    else if (a.command) what = `<pre>${escH(a.command)}</pre>${a.description ? `<p class="perm-desc">${escH(a.description)}</p>` : ''}`;
    else if (a.url || a.query) what = `<pre>${escH(a.url || a.query)}</pre>`;
    return `<div class="card perm"><div class="card-h">${ICON[kind] || ICON.shield}<span>${title}</span></div>${what}<div class="btns">${permBtns(selectedId, 'data-keys', true)}</div></div>`;
  }
  // A permission dialog as the CLI draws it: its question ("Do you want to make this edit to hello.txt?") and the
  // rows above it, up to the rule that opens the dialog, frame lines left out. null when none is on screen.
  function screenPerm(id) {
    const rows = screenOf(id, 50, true) || []; let q = -1;
    for (let k = rows.length - 1; k >= 0 && k >= rows.length - 14; k--) if (/Do\s+you\s+want\s+to\b.*\?/.test(rows[k])) { q = k; break; }
    if (q < 0) return null;
    let top = q - 1; while (top >= 0 && !/^\s*─{10,}/.test(rows[top]) && q - top < 30) top--;
    const body = rows.slice(top + 1, q).map(r => r.replace(/╌{3,}/g, '').replace(/^ /, '').replace(/\s+$/, '')).filter(r => r.trim() && !/^[\s─│]*$/.test(r) && !/^\s*Tip:/.test(r));
    return { question: rows[q].trim(), body };
  }
  // The terminal's open menu ("❯ 1. Yes …  2. No …"), read off its last lines: the plan card's choices are exactly
  // the CLI's, whatever this version offers.
  function menuOptions(id) { return screenAsk(id).options.map(o => o.label); }
  // A permission's keys go only to a menu that's really on screen (a slow tool can look like one waiting for you).
  // A permission menu starts "1. Yes" (a numbered list in Claude's reply doesn't).
  const permMenu = (id) => { const o = menuOptions(id); return o.length >= 2 && /^yes\b/i.test(o[0]) ? o : null; };
  const menuUp = (id) => !!permMenu(id);
  // Its buttons are the menu's own choices (a Yes/No prompt has no "always"); the usual ones before it has drawn.
  function permBtns(id, attr, kbd) {
    const o = permMenu(id), list = o ? o.slice(0, 4).map((l, k) => [String(k + 1), l.length > 42 ? l.slice(0, 40) + '…' : l]) : [['1', 'Allow once'], ['2', 'Always allow']];
    const b = (k, l, j) => `<button type="button"${j ? '' : ' class="primary"'} ${attr}="${k}" title="${escH(l)}">${escH(l)}${kbd ? `<kbd>${k === 'esc' ? 'Esc' : k}</kbd>` : ''}</button>`;
    return list.map(([k, l], j) => b(k, l, j)).join('') + (list.some(([, l]) => /^no\b/i.test(l)) ? '' : b('esc', 'Deny', 1));
  }
  // The open question as the CLI draws it: the line above its menu, and each option with the lines under it. A question
  // isn't in the transcript until it's answered, so this is the only place it can be read from while it waits.
  // The last n rows of an agent's terminal screen (chat-core.js bufferRows); null while it has no terminal yet.
  const screenOf = (id, n, joinWrapped = false) => { const x = typeof xterms !== 'undefined' && xterms.get(id); return x && x.terminal ? bufferRows(x.terminal.buffer.active, n, joinWrapped) : null; };
  function screenAsk(id) {
    let rows = screenOf(id, 40, true); if (!rows) return { question: '', options: [] }; // a row the terminal wrapped is one line
    rows = rows.flatMap(r => { const m = /^(\s*[─━]{20,})(.*\S.*)$/.exec(r); return m ? [m[1], m[2]] : [r]; }); // a full-width rule the next row wrapped onto ("───  4. Chat about this") is two rows
    const cut = (s) => s.replace(/^\s*[│┃|]?\s*/, '').split(/\s{3,}|[│┃┌└├┐┘┤╭╮╰╯─━✂]/)[0].trim(); // a left rule goes; a preview drawn beside isn't part of it
    const OPT = /^\s*[❯›>]?\s*(\d)\.\s+(.+?)\s*$/, options = []; let first = -1, focus = 0;
    // The focused option's preview, drawn in a box to the right of the menu: its column splits every row in two.
    const top = rows.findIndex(r => OPT.test(r)), col = top < 0 ? -1 : Math.min(...rows.slice(top).map(r => { const k = r.search(/[┌╭]/); return k > 0 ? k : Infinity; }));
    const preview = [], dialog = screenDialog(rows);
    if (col > 0 && col < Infinity) {
      let inBox = false;
      for (let i = top; i < rows.length; i++) {
        const s = rows[i].slice(col);
        if (/^[┌╭]/.test(s)) inBox = true;
        else if (/^[└╰]/.test(s)) { rows[i] = rows[i].slice(0, col); break; }
        else if (inBox) preview.push(s.replace(/^[│┃├]\s?/, '').replace(/\s*[│┃┤]\s*$/, '').replace(/^[─━\s]*✂.*$/, '…'));
        rows[i] = rows[i].slice(0, col); // the menu's side of the row
      }
    }
    let rule = false; // a rule between options: what's under it ("Chat about this") is apart from the answers
    rows.forEach((r, i) => {
      const m = OPT.exec(r);
      if (m) { if (first < 0) first = i; options[+m[1] - 1] = { label: cut(m[2]), desc: '', sep: rule && options.length > 0 }; rule = false; if (/^\s*[❯›>]/.test(r)) focus = +m[1] - 1; return; }
      if (first >= 0 && /^\s*[─━]{3,}\s*$/.test(r)) { rule = true; return; }
      const last = options[options.length - 1], d = cut(r);
      if (!last || first < 0 || !d || !/^\s{3,}/.test(r) || /^(Enter|Esc|↑|Tab|Notes:)/.test(d)) return;
      if (/^\(.*\)$/.test(d) && !last.desc) last.label += ' ' + d; // "(Recommended)" wrapped under its label
      else last.desc = (last.desc ? last.desc + ' ' : '') + d;
    });
    // The question: the lines just above the menu (it can wrap, inside a left rule), up to a blank line.
    const q = [];
    for (let i = first - 1; i >= 0 && i >= first - 12; i--) { const t = cut(/^\s*[│┃]/.test(rows[i]) ? rows[i].replace(/\s*[│┃]\s*/g, ' ') : rows[i]); /* inside a left rule, a wrapped row's own rule ("…Raw│ .glb…") is a space */ if (!t) { if (q.length) break; continue; } if (/[←→]|^\[[ x✓]?\]|^[☐☑✔]/.test(t)) break; q.unshift(t); }
    // A menu with no "Esc to cancel" under it (the review before submitting several answers): open while its options,
    // one marked ❯, are the last thing on screen.
    const nb = rows.filter(r => r.trim()), menuLast = nb.length > 0 && OPT.test(nb[nb.length - 1]) && rows.some(r => /^\s*[❯›]\s*\d\.\s/.test(r));
    // Several questions at once: the CLI's tab row above them ("← [ ] Scope  ✓ Workspace  ✓ Submit →"), ticked once answered.
    const tabRow = rows.slice(0, Math.max(0, first)).reverse().find(r => /\bSubmit\b/.test(r) && /\[[ x✓✔]?\]|[☐☒☑✓✔]/.test(r));
    const tabs = tabRow ? [...tabRow.matchAll(/(\[[ x✓✔×]?\]|[☐☒☑✓✔])\s*(.+?)(?=\s{2,}|\s*(?:\[|[☐☒☑✓✔→])|\s*$)/g)].map(m => ({ done: !/^(\[ ?\]|☐)$/.test(m[1]), label: m[2].trim() })).filter(x => x.label && !/^Submit$/i.test(x.label)) : [];
    // An answer you already gave is ticked ("Small fix ✔"). A typed one replaces "Type something." in its row, the one
    // just above "Chat about this": it is still that row, holding your text.
    const opts = options.filter(Boolean);
    for (const o of opts) { const m = /^(.*?)\s*[✔✓√]$/.exec(o.label); if (m && m[1]) { o.label = m[1]; o.chosen = true; } }
    const chat = opts.findIndex(o => o.sep && /^chat about this/i.test(o.label)), t = chat > 0 && opts[chat - 1];
    if (t && !opts.some(o => /^(type something|other)\b/i.test(o.label)) && !isBox(t.label)) { t.typed = t.label; t.label = 'Type something.'; }
    return { question: q.join(' ').replace(/^[?❓\s]+/, ''), options: opts, focus, preview: preview.join('\n').replace(/\s+$/, ''), dialog: first >= 0 && (dialog || menuLast), tabs };
  }
  // The CLI's rewind list (Esc Esc): each earlier prompt, the change made after it ("2 files changed +83") and which
  // one is selected. null when it isn't on screen.
  function screenRewind(id) {
    const rows = screenOf(id, 60); if (!rows) return null;
    let i0 = -1; for (let i = rows.length - 1; i >= 0; i--) if (/^\s*Rewind\s*$/.test(rows[i])) { i0 = i; break; }
    if (i0 < 0 || !screenDialog(rows)) return null;
    const items = []; let focus = -1;
    for (const r of rows.slice(i0 + 1)) {
      if (!r.trim() || /^\s*Restore the code/i.test(r)) continue;
      if (/\besc to (cancel|exit)/i.test(r)) break;
      const on = /^\s*❯\s/.test(r), t = r.replace(/^\s*❯?\s*/, '').trim(), last = items[items.length - 1];
      if (!on && last && !last.meta && /^(\d+ files? changed|\S+\.\w+)(\s+[+-]\d+)+$/.test(t)) { last.meta = t; continue; }
      if (on) focus = items.length;
      items.push({ label: t, meta: '' });
    }
    return items.length ? { items, focus: Math.max(0, focus) } : null;
  }
  function rewindHtml(rw) {
    return `<div class="card ask rewind"><div class="card-h">${ICON.undo || ICON.ask}<span>Rewind to before…</span></div><div class="choices">${rw.items.map((it, k) => `<button type="button" data-rw="${k}" class="${k === rw.focus ? 'focus' : ''}"><span class="ch-t"><b>${escH(it.label === '(current)' ? 'Now (keep everything)' : it.label)}</b>${it.meta ? `<small>${escH(it.meta)}</small>` : ''}</span></button>`).join('')}<button type="button" class="other" data-rwx="1"><span>Cancel</span></button></div></div>`;
  }
  // Pick rewind point k: the CLI's selection moves there, then Enter (its next menu, what to restore, is a question card).
  function rewindPick(k) { const rw = screenRewind(selectedId); if (!rw) return; const d = k - rw.focus; keys([...arrowKeys(d), '\r']); setTimeout(rerender, Math.abs(d) * 70 + 400); }
  function rewindStep(d) { const rw = screenRewind(selectedId); if (!rw) return false; keys([d > 0 ? '\x1b[B' : '\x1b[A']); setTimeout(rerender, 200); return true; }
  // A proposed plan waiting for approval: the plan itself, rendered, and the CLI's own choices as buttons.
  function planHtml(ev, cwd) {
    const opts = menuOptions(selectedId), labels = opts.length ? opts : ['Yes, and auto-accept edits', 'Yes, and manually approve edits', 'No, keep planning'];
    return `<div class="card ask plan-ask"><div class="card-h">${ICON.plan}<span>Ready to code? Here's the plan</span></div><div class="md sub plan">${md(String(ev.args.plan || '').replace(/^#{1,6}\s*plan\s*\n+/i, ''), cwd)}</div><div class="choices">${labels.map((l, k) => `<button type="button" data-pick="${k}"><kbd>${k + 1}</kbd><span class="ch-t"><b>${escH(l)}</b></span></button>`).join('')}</div></div>`;
  }
  // Which step of a several-question prompt the CLI is on: it only shows that by colour (the step's name on a filled
  // background), and the question isn't in the transcript until it's answered. -1 when it can't tell.
  function tabLit(id, labels) {
    const x = typeof xterms !== 'undefined' && xterms.get(id); if (!x || !labels.length) return -1;
    const b = x.terminal.buffer.active;
    for (let y = b.length - 1; y >= Math.max(0, b.length - 80); y--) {
      const line = b.getLine(y), s = line && line.translateToString(true); if (!s || !/\bSubmit\b/.test(s)) continue;
      for (let k = 0; k < labels.length; k++) { const c = s.indexOf(labels[k]) >= 0 && line.getCell(s.indexOf(labels[k])); if (c && (c.isInverse() || !c.isBgDefault())) return k; }
      return -1;
    }
    return -1;
  }
  // A plan waiting for approval: the transcript has it only once answered, but the CLI names its file under the
  // menu ("~\.claude\plans\x.md"): read it from there, so the card shows the plan itself.
  const planTexts = new Map(); // file → its text ('' while asked)
  function planOnScreen(id) {
    const rows = screenOf(id, 40, true) || [], m = /(~?[\\/]?[^\s·]*\.claude[\\/]plans[\\/][\w.-]+\.md)/.exec(rows.join('\n'));
    if (!m || !/would you like to proceed|plan/i.test(rows.join(' '))) return '';
    const a = agents.get(id);
    if (!planTexts.has(m[1])) { planTexts.set(m[1], ''); api.send({ type: 'filePeek', cwd: (a && a.cwd) || '', file: m[1], line: 1, all: true, seq: 'plan:' + m[1] }); }
    return planTexts.get(m[1]) || '';
  }
  const isBox = (l) => /^\[.?\]\s/.test(String(l || ''));
  // "[✔] Basil" → a ticked box and its name
  const boxLabel = (l) => { const m = /^\[(.?)\]\s*(.*)$/.exec(String(l)); return m ? `<span class="chk${m[1].trim() ? ' on' : ''}" aria-hidden="true">${m[1].trim() ? ICON.check : ''}</span>${escH(m[2])}` : escH(l); };
  function askHtml(ask, perm) {
    const pl = planOnScreen(selectedId); if (pl) return planHtml({ args: { plan: pl } }, (agents.get(selectedId) || {}).cwd);
    const s = screenAsk(selectedId); // the open question is only on screen until it's answered
    const a = (ask && ask.args) || {}, opts = s && s.options.length ? s.options : a.options || [];
    const q = (s && s.question) || a.question || 'Claude has a question';
    if (askFor !== selectedId + '\n' + q) { askFor = selectedId + '\n' + q; askHover = null; askAsked = null; askTyped = ''; } // a new question starts from its focused option
    // Several questions: which one this is, which are answered (the CLI's tab row).
    // The review before sending several answers ("Ready to submit your answers?"): the Submit step, with the answers given.
    const review = !!(s && s.tabs && s.tabs.length > 1) && /submit your answers/i.test(q);
    const norm = (x) => String(x || '').replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 40), at = (a.steps || []).findIndex(x => norm(x.q) === norm(q)), lit = at >= 0 || review ? -1 : tabLit(selectedId, ((s && s.tabs) || []).map(x => x.label)), on = review ? s.tabs.length : at >= 0 ? at : lit >= 0 ? lit : ((s && s.tabs) || []).findIndex(x => !x.done); // else the first one not answered
    const tabs = s && s.tabs && s.tabs.length > 1 ? `<div class="ask-tabs" data-on="${on < 0 ? s.tabs.length : on}">${s.tabs.map((x, k) => `<span data-tab="${k}" class="${x.done ? 'done' : ''}${k === on ? ' on' : ''}">${x.done ? ICON.check : `<i>${k + 1}</i>`}${escH(x.label)}</span>`).join('')}<span data-tab="${s.tabs.length}" class="sub${on < 0 || on >= s.tabs.length ? ' on' : ''}">Submit</span></div>` : ''; // the CLI's last step: review and send
    // Pick-several: its options are boxes ("[ ] Cheese", "[✔] Basil"); a number toggles one, Submit sends them.
    const multi = opts.some(o => isBox(o.label ?? o));
    const stepKey = tabs ? 'steps:' + s.tabs.map(x => x.label).join('|') : q;
    // The review's body, as the CLI draws it: "⚠ You have not answered all questions", then "● question" / "→ answer".
    let rv = '';
    if (review) {
      const rows = screenOf(selectedId, 40, true) || [], from = rows.findIndex(r => /review your answers/i.test(r)), to = rows.findIndex((r, i) => i > from && /submit your answers/i.test(r));
      const body = from >= 0 && to > from ? rows.slice(from + 1, to).map(r => r.trim()).filter(Boolean) : [];
      rv = body.length ? `<div class="ask-review">${body.map(r => /^⚠/.test(r) ? `<div class="warn">${escH(r.replace(/^⚠\s*/, ''))}</div>` : /^→/.test(r) ? `<div class="ans">${escH(r.replace(/^→\s*/, ''))}</div>` : `<div class="rq">${escH(r.replace(/^●\s*/, ''))}</div>`).join('')}</div>` : '';
    }
    return `<div class="card ask">${tabs}${rv}<div class="card-h">${ICON.ask}<span>${escH(q)}</span></div><div class="choices">${opts.map((o, k) => s.options.length && k === askFocus(s) && /^type something/i.test(o.label ?? o) ? `<div class="ask-typing focus${o.sep ? ' sep' : ''}" data-pick="${k}"><kbd>${k + 1}</kbd><input class="ask-in" type="text" placeholder="Type your answer, Enter to send" aria-label="Your answer"></div>` : `<button type="button" data-pick="${k}"${s.options.length ? ' data-hov="1"' : ''} class="${s.options.length && k === askFocus(s) ? 'focus' : ''}${o.sep ? ' sep' : ''}"><kbd>${k + 1}</kbd><span class="ch-t"><b>${o.typed ? escH(o.typed) : boxLabel(o.label ?? o)}${o.chosen || o.typed ? `<span class="chosen" aria-label="Your answer">${ICON.check}</span>` : ''}</b>${o.desc && !/^submit$/i.test(o.desc) ? `<small>${escH(o.desc)}</small>` : ''}</span></button>`).join('')}${multi ? `<button type="button" class="other submit" data-act="ask-submit"><span>Submit</span></button>` : review || opts.some(o => /^(\[.?\]\s*)?(type something|other)\b/i.test(o.label ?? o)) ? '' : `<button type="button" class="other" data-act="answer"><kbd>${opts.length + 1}</kbd><span>${opts.length ? 'Something else' : 'Answer in terminal'}</span></button>`}</div>${prevHtml(q, s)}</div></div>`
      .replace('<div class="choices">', `<div class="ask-body"><div class="choices">`)
      .replace('<div class="card ask">', `<div class="card ask${lastAskQ === stepKey ? ' still' : ''}">`) + (lastAskQ = stepKey, ''); // one card through its steps: no slide-in at each
  }
  // ── Background shells and subagents: one small pill above the reply box ("10 agents · 1 shell"). Hover it for the list,
  // click to keep the list open; a row's hover card peeks, a click opens its full panel. ──
  let dockHtml = '', dockCount = { agents: 0, shells: 0 };
  function drawDock() {
    let el = document.getElementById('chat-bg');
    if (!el) {
      el = document.createElement('div'); el.id = 'chat-bg';
      el.innerHTML = `<button type="button" class="bg-pill" aria-expanded="false" aria-haspopup="true"><span class="bga-dot"></span><span class="bg-n"></span>${ICON.chev}</button><div class="bg-pop" role="menu" aria-label="Running in the background"></div>`;
      document.getElementById('term-order').prepend(el);
      const pill = el.querySelector('.bg-pill');
      el.addEventListener('click', (e) => {
        if (e.target.closest('.bg-pill')) { const on = !el.classList.contains('pinned'); el.classList.toggle('pinned', on); pill.setAttribute('aria-expanded', on); return; }
        const sh = e.target.closest('[data-bgout]'); if (sh) { hideHover(); closeDock(); return openShell(sh.dataset.bgout, sh.dataset.bgname); }
        const ag = e.target.closest('[data-jump]'); if (ag) { hideHover(); closeDock(); openAgent(ag.dataset.jump, worldTl && worldTl.id === selectedId ? worldTl.events : []); }
      });
      el.addEventListener('mouseover', (e) => { const b = e.target.closest('.bga'); if (b && b !== hoverFor) showHover(b, true); });
      el.addEventListener('mouseleave', hideHover);
      document.addEventListener('mousedown', (e) => { if (!el.contains(e.target) && !e.target.closest('#chat-hover')) closeDock(); });
      el.addEventListener('keydown', (e) => { if (e.key === 'Escape' && el.classList.contains('pinned')) { e.stopPropagation(); closeDock(); pill.focus(); } });
    }
    const pop = el.querySelector('.bg-pop'), n = el.querySelector('.bg-n');
    const { agents: na, shells: ns } = dockCount;
    const label = [na ? `${na} agent${na > 1 ? 's' : ''}` : '', ns ? `${ns} shell${ns > 1 ? 's' : ''}` : ''].filter(Boolean).join(' · ');
    if (n.textContent !== label) n.textContent = label;
    // Only the timers tick: swap their text in place, so a hovered row isn't rebuilt under the pointer.
    const key = liveKey(dockHtml);
    if (pop._k === key) { const tmp = document.createElement('div'); tmp.innerHTML = dockHtml; for (const x of tmp.querySelectorAll('[data-live]')) { const c = pop.querySelector(`[data-live="${CSS.escape(x.dataset.live)}"]`); if (c && c.textContent !== x.textContent) c.textContent = x.textContent; } }
    else { pop.innerHTML = dockHtml; pop._k = key; if (hoverFor && !pop.contains(hoverFor)) hideHover(); }
    el.hidden = !dockHtml; if (!dockHtml) closeDock();
  }
  // A question's previews: the CLI draws only the selected option's, so each one is kept once seen. The card shows the
  // hovered option's (else the selected one's) in its own space under the options, as tall as the tallest seen, so the
  // options never move under the pointer.
  const previews = new Map(); // question → [preview per option]
  let askHover = null, askAsked = null, askFor = '';
  let lastAskQ = null; // the same question redrawn doesn't slide in again
  const prevText = (t) => t == null ? '<span class="ap-wait">…</span>' : t ? escH(t) : '<span class="ap-wait">No preview</span>';
  function prevHtml(q, s) {
    if (!s.options.length) return '';
    const seen = previews.get(q) || []; previews.set(q, seen);
    if (s.preview || seen[s.focus] == null) seen[s.focus] = /^No preview available$/i.test(s.preview) ? '' : s.preview;
    if (!seen.some(Boolean)) return ''; // a question without previews
    // Drawn with the selected option's preview; a hover swaps only this pane's text (applyAskHover), never the card.
    const rows = Math.max(...seen.filter(Boolean).map(p => p.split('\n').length));
    return `<pre class="ask-prev" data-q="${escH(q)}" data-focus="${askFocus(s)}" style="min-height:calc(${rows} * 1.5em + 18px)">${prevText(seen[askFocus(s)])}</pre>`;
  }
  function applyAskHover() {
    const pane = document.querySelector('#conversation .card.ask .ask-prev'), card = pane && pane.closest('.card');
    for (const b of document.querySelectorAll('#conversation .card.ask [data-hov]')) b.classList.toggle('hov', +b.dataset.pick === askHover);
    if (!pane) return;
    const seen = previews.get(pane.dataset.q) || [], k = askHover != null && card.querySelector(`[data-pick="${askHover}"]`) ? askHover : +pane.dataset.focus;
    const h = prevText(seen[k]); if (pane._h !== h) { pane.innerHTML = h; pane._h = h; }
  }
  // ↑/↓ from the reply box: one step, wrapping like the CLI's menu; the preview follows the selection.
  function askStep(d) { const s = screenAsk(selectedId), n = s.options.length; if (!n) return false; askHover = null; askMove((askFocus(s) + d + n) % n); return true; }
  // Move the CLI's selection to option k (arrow keys). The card moves at once; until the CLI has redrawn, it (and the
  // next press) go by where the cursor will be, not by a screen that's a step behind.
  let askAhead = null; // { q, focus, at }
  function askFocus(s) {
    if (!askAhead || askAhead.q !== s.question || Date.now() - askAhead.at > 1500 || askAhead.focus === s.focus) { askAhead = null; return s.focus; }
    return askAhead.focus;
  }
  function askMove(k) {
    const s = screenAsk(selectedId), d = k - askFocus(s); if (!s.options.length || !d) return;
    keys(arrowKeys(d));
    askAhead = { q: s.question, focus: k, at: Date.now() };
    for (const b of document.querySelectorAll('#conversation .card.ask .choices [data-pick]')) b.classList.toggle('focus', +b.dataset.pick === k);
    const pane = document.querySelector('#conversation .card.ask .ask-prev'); if (pane) { pane.dataset.focus = k; applyAskHover(); }
    setTimeout(rerender, Math.abs(d) * 70 + 200);
  }
  // The "Type something" row as a text field (shown while it's the selected option). Redraws rebuild the card: the text
  // lives here and goes back in. Reaching it (a click, its number, the arrows) puts the caret in it; Enter sends it as
  // the answer (its number, then the text), ↑/↓ move on, Esc goes back to the reply box.
  let askTyped = '', askFocusIn = false;
  function keepAskInput() {
    const i = document.querySelector('#conversation .card.ask .ask-in'); if (!i) return;
    const row = screenAsk(selectedId).options[+i.closest('[data-pick]').dataset.pick] || {};
    if (!i._wired && !askTyped && row.typed) askTyped = row.typed; // an answer typed before: it's there to edit
    if (i.value !== askTyped) i.value = askTyped;
    if (i._wired) return; i._wired = 1;
    const box = document.getElementById('term-order-input'), ae = document.activeElement;
    if (askFocusIn || ((ae === box || ae === document.body) && !box.value)) { i.focus(); i.selectionStart = i.selectionEnd = i.value.length; }
    askFocusIn = false;
    i.addEventListener('input', () => { askTyped = i.value; });
    i.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.isComposing) return;
      if (e.key === 'Enter') {
        e.preventDefault(); const t = i.value.trim(), id = selectedId, k = +i.closest('[data-pick]').dataset.pick; if (!t) return;
        askTyped = ''; i.disabled = true; i.closest('.card')?.classList.add('picked-card');
        const old = (screenAsk(id).options[k] || {}).typed || ''; // the CLI's row still holds it: erase it, then type the new one
        askMove(k); setTimeout(() => { if (old) keys(Array(old.length).fill('\x7f')); setTimeout(() => chatComposer.sendText(id, t), old ? old.length * 70 + 300 : 0); }, 400); // keys go out ~70ms apart // its number would be typed into it once the CLI's cursor is there: move there, then the text
      } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); box.focus(); askStep(e.key === 'ArrowDown' ? 1 : -1); }
      else if (e.key === 'Escape') { e.preventDefault(); box.focus(); }
    });
  }
  // Several questions: ←/→ (or a click on its step) go to another one, as in the CLI's tab row.
  function askTab(d) {
    if (!d || !document.querySelector('#conversation .card.ask .ask-tabs')) return false;
    // On "Type something" the CLI's ←/→ move the caret in its text: step off it first, or the step never changes.
    const s = screenAsk(selectedId), o = s.options[askFocus(s)], off = /^type something/i.test((o && (o.label ?? o)) || '');
    keys([...(off ? ['\x1b[A'] : []), ...Array(Math.abs(d)).fill(d > 0 ? '\x1b[C' : '\x1b[D')]);
    askAhead = null; setTimeout(rerender, Math.abs(d) * 70 + 200); setTimeout(rerender, Math.abs(d) * 70 + 600);
    return true;
  }
  document.getElementById('conversation').addEventListener('mouseover', (e) => {
    const b = e.target.closest('.card.ask [data-hov]');
    if (!b) { if (askHover != null && !e.target.closest('.card.ask .ask-prev')) { askHover = null; askAsked = null; applyAskHover(); } return; } // off the options: the selected one's again
    const k = +b.dataset.pick; if (askHover === k) return;
    askHover = k; applyAskHover();
    // Not seen yet: have the CLI show it, once per option.
    const s = screenAsk(selectedId), seen = previews.get(s.question) || [];
    if (seen.some(Boolean) && seen[k] == null && askAsked !== k) { askAsked = k; askMove(k); }
  });
  function closeDock() { const el = document.getElementById('chat-bg'); if (el) { el.classList.remove('pinned'); el.querySelector('.bg-pill')?.setAttribute('aria-expanded', 'false'); } }
  let hoverFor = null;
  const hoverEl = document.createElement('div'); hoverEl.id = 'chat-hover'; hoverEl.hidden = true; hoverEl.setAttribute('role', 'tooltip'); document.body.appendChild(hoverEl);
  function showHover(b, side) {
    hoverFor = b;
    const shell = b.matches('[data-bgout]'), name = b.querySelector('.bga-n').textContent, t = b.querySelector('.bga-t').textContent;
    hoverEl.innerHTML = `<div class="hv-h">${shell ? ICON.cmd : ICON.agent}<b>${escH(name)}</b><span>${escH(t)}</span></div>`
      + (shell ? (b.dataset.cmd && b.dataset.cmd !== name ? `<pre class="hv-cmd">${escH(b.dataset.cmd)}</pre>` : '') : `${b.dataset.kind ? `<div class="hv-k">${escH(b.dataset.kind)}</div>` : ''}${b.dataset.task ? `<div class="hv-task">${escH(b.dataset.task)}</div>` : ''}`)
      + '<div class="hv-live">…</div><div class="hv-foot">Click for more</div>';
    hoverEl.hidden = false;
    const r = b.getBoundingClientRect(), h = hoverEl.getBoundingClientRect();
    if (side) { const right = r.right + 8 + h.width < innerWidth; hoverEl.style.left = (right ? r.right + 8 : Math.max(8, r.left - h.width - 8)) + 'px'; hoverEl.style.top = Math.max(8, Math.min(r.top, innerHeight - h.height - 8)) + 'px'; } // beside a list row
    else { hoverEl.style.left = Math.max(8, Math.min(r.left, innerWidth - h.width - 8)) + 'px'; hoverEl.style.top = Math.max(8, r.top - h.height - 8) + 'px'; }
    if (shell) api.send({ type: 'bgTail', id: selectedId, file: b.dataset.bgout });
    else api.send({ type: 'agentSteps', id: selectedId, toolId: b.dataset.jump });
  }
  function hideHover() { hoverFor = null; hoverEl.hidden = true; }
  // The live line of the hover card: a shell's last output lines, an agent's step count and latest step.
  function hoverLive(msg) {
    if (!hoverFor || hoverEl.hidden) return;
    const box = hoverEl.querySelector('.hv-live'); if (!box) return;
    if (msg.type === 'bgTail' && hoverFor.dataset.bgout === msg.file) { const ls = String(msg.text || '').split('\n').map(l => l.trimEnd()).filter(Boolean).slice(-3); box.className = 'hv-live out'; box.textContent = ls.length ? ls.join('\n') : 'No output yet'; }
    if (msg.type === 'agentSteps' && hoverFor.dataset.jump === msg.toolId) {
      const tools = (msg.events || []).filter(e => e.type === 'tool'), last = tools[tools.length - 1], v = last && toolView(last, true);
      box.className = 'hv-live'; box.textContent = tools.length ? `${tools.length} step${tools.length > 1 ? 's' : ''} · ${v.verb}${v.target ? ' ' + v.target : ''}` : 'Starting…';
    }
  }
  // What Claude last printed before it quit (its terminal's last lines, Overlord's own "[Crashed…]" notes left out):
  // the reason, when there is one.
  function lastWords(id) {
    const rows = screenOf(id, 60); if (!rows) return '';
    return rows.filter(r => r.trim() && !/^\[(Crashed|Session ended|Previous session)/.test(r.trim()) && !/^[─━\s]+$/.test(r)).slice(-8).join('\n');
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
    // A crash or restart kills them without a notification; Overlord's resume prompt marks that point.
    // So does Claude's process ending: nothing launched before the current one still runs.
    let cut = -1; evs.forEach((e, k) => { if (e.type === 'resumed' || (a.procAt && e.ts && Date.parse(e.ts) < a.procAt)) cut = k; });
    const bg = evs.filter((e, k) => { if (k <= cut || e.type !== 'tool' || (e.name !== 'Agent' && e.name !== 'Task')) return false; const d = doneBy.get(e.toolId); return !d || (d.agentId && /background|launched/i.test(d.text) && !ended.has(d.agentId)); });
    // Background shells (Bash run_in_background) until their task-notification: a chip each, opening to the live output.
    const shells = evs.filter((e, k) => k > cut && e.type === 'tool' && doneBy.get(e.toolId) && doneBy.get(e.toolId).bgId && !ended.has(doneBy.get(e.toolId).bgId));
    // Both dock above the reply box (paint puts dockHtml in #chat-bg), out of the scrolling thread.
    const since = (e) => e.ts ? escH(dur(now - Date.parse(e.ts))) : '';
    dockCount = { agents: bg.length, shells: shells.length };
    dockHtml = shells.map(e => { const d = doneBy.get(e.toolId), a2 = e.args || {}, name = a2.description || a2.command || 'Background shell';
      return `<button type="button" role="menuitem" class="bga bgsh" data-bgout="${escH(d.bgOut)}" data-bgname="${escH(name)}" data-cmd="${escH(a2.command || '')}">${ICON.cmd}<span class="bga-n">${escH(name)}</span><span class="bga-t" data-live="s${escH(e.toolId)}">${since(e)}</span><span class="bga-dot"></span></button>`; }).join('')
      + bg.map(e => { const a2 = e.args || {};
        return `<button type="button" role="menuitem" class="bga" data-jump="${escH(e.toolId)}" data-kind="${escH(a2.subagent_type || '')}" data-task="${escH(String(a2.prompt || '').split('\n').find(l => l.trim()) || '')}">${ICON.agent}<span class="bga-n">${escH(a2.description || a2.subagent_type || 'Agent')}</span><span class="bga-t" data-live="b${escH(e.toolId)}">${since(e)}</span><span class="bga-dot"></span></button>`; }).join('');
    // A menu on the CLI's screen that main didn't flag (a question with previews, say): still a question card, not the raw terminal.
    if (!perm) { const rw = screenRewind(selectedId); if (rw) return h + rewindHtml(rw); const sa = screenAsk(selectedId); if (sa.dialog && sa.options.length >= 2) return h + askHtml(lastTool(evs, 'AskUserQuestion', doneBy), null); }
    if (perm && perm.perm === 'ask') { const plan = lastTool(evs, 'ExitPlanMode', doneBy); return h + (plan && plan.args && plan.args.plan ? planHtml(plan, a.cwd) : askHtml(lastTool(evs, 'AskUserQuestion', doneBy), perm)); }
    if (perm) return h + permHtml(perm, evs, doneBy);
    if (a.crashed === 'fatal') return h + `<div class="card err"><div class="card-h">${ICON.alert}<span>The agent stopped</span></div><p>Claude quit ${a.crashMax} times in a row right after starting.</p>${(() => { const t = lastWords(selectedId); return t ? `<pre class="crash-out">${escH(t)}</pre>` : ''; })()}<div class="btns"><button class="primary" type="button" data-act="resume">Resume</button></div></div>`;
    if (a.compacting) return h + `<div class="working">${SPARK}<span class="shimmer">Compacting conversation…</span></div>`;
    if (st === 'active' || st === 'resuming') {
      // The CLI's own playful verb ("Cogitating…") when it has one; elapsed; the Esc hint. The call in flight already
      // shows as the running row just above, so it isn't repeated here.
      // Elapsed and tokens written this turn, like the CLI's "(1m 4s · ↓ 3.2k tokens · esc to interrupt)".
      const tok = a.stats && a._tok0 != null ? (a.stats.outTok || 0) - a._tok0 : 0;
      const meta = [a.activeAt ? dur(now - a.activeAt) : '', tok > 0 ? '↓ ' + (tok >= 1000 ? (tok / 1000).toFixed(1) + 'k' : tok) + ' tokens' : ''].filter(Boolean).map(escH).join(' · ');
      return h + `<div class="live-reply" hidden></div><div class="working">${SPARK}<span class="shimmer" data-live="v">${escH(a.spinnerText || (bg.length ? `Waiting for ${bg.length} background agent${bg.length > 1 ? 's' : ''}…` : 'Thinking…'))}</span><span class="w-hint"><span data-live="m">${meta}</span>${meta ? ' · ' : ''}<kbd>Esc</kbd><span class="w-x"> to interrupt</span></span></div>`;
    }
    return h;
  }

  // A prompt sent from the composer shows at once, dimmed, until the transcript writes it (or the agent queues it).
  // It matches the transcript's prompt with the [Image #N] tags Claude adds for its images taken out.
  // Several can wait at once (each prompt you send while the agent works); each queued one has ✕ to take it back.
  const pending = new Map(); // agent id → [{ text, imgs, at, held, busyAt }]
  const norm = (s) => String(s || '').replace(/\[Image #\d+\]/g, ' ').replace(/\s+/g, ' ').trim();
  const usedPrompts = new Map(); // agent id → the transcript messages (by time) that already cleared a bubble
  // What sits in the CLI's queue now (typed in the terminal, or anywhere): its bubbles, as the CLI shows them. One not
  // taken by the end of a turn was dropped (a crash): only what came since the last turn counts. The chat's own waiting
  // messages have their bubbles already.
  function cliQueue(id, evs) {
    let q = [];
    for (const e of evs) {
      if (e.type === 'turn') q = [];
      else if (e.type !== 'queue') continue;
      else if (e.op === 'enqueue') q.push(e);
      else if (e.op === 'dequeue') q.shift();
      else { const k = q.findIndex(x => x.text === e.text); if (k >= 0) q.splice(k, 1); }
    }
    // Each of the chat's own waiting bubbles stands for one entry: same text, or (its images and pastes read differently
    // in the CLI) queued within seconds of it being sent.
    const mine = [...(pending.get(id) || [])];
    const own = (e) => { const t = e.text.trim(); let k = mine.findIndex(p => (p.match || p.text || '').trim() === t); if (k < 0) k = mine.findIndex(p => Math.abs(Date.parse(e.ts) - p.at) < 15000); return k >= 0 && !!mine.splice(k, 1); };
    return q.filter(e => !e.sys && e.text.trim() && !own(e))
      .map(e => `<div class="msg user pending cliq"><div class="bubble">${tagChips(e.text)}</div><span class="q">Queued</span></div>`).join('');
  }
  function pendingHtml(id, evs, busy) {
    const list = pending.get(id); if (!list || !list.length) return cliQueue(id, evs);
    // Each message sent from here becomes the next message of yours in the transcript, in the order sent, so they clear
    // in that order: the first one of yours written after a message was sent is that message, whatever the CLI made of its
    // text (its own image numbers, a long paste's wrapper, text left in its box…). Matching the text broke on each of those.
    // One still being attached isn't sent yet. A message sent while the agent works can wait in the CLI's queue until the
    // turn ends, so a leftover only expires once the agent has been idle a while without it showing up.
    // A message of yours in the transcript clears one bubble only, ever: one that already cleared a bubble on an earlier
    // redraw can't clear the next one too.
    const used = usedPrompts.get(id) || new Set(); usedPrompts.set(id, used);
    const yours = evs.filter(e => (e.type === 'prompt' || e.type === 'command') && e.ts && !used.has(e.ts)).map(e => e.ts).sort((x, y) => Date.parse(x) - Date.parse(y));
    let j = 0;
    for (const p of [...list].sort((x, y) => x.at - y.at)) {
      if (busy) p.busyAt = Date.now();
      if (p.held) continue;
      while (j < yours.length && Date.parse(yours[j]) < p.at - 500) j++;
      if (j < yours.length) { used.add(yours[j]); j++; list.splice(list.indexOf(p), 1); continue; }
      if (!busy && Date.now() - (p.busyAt || p.at) > 30000) list.splice(list.indexOf(p), 1);
    }
    return list.map((p, k) => {
      const imgs = thumbs(p.imgs, tagNums(p.text));
      const queued = busy && !p.held;
      return `<div class="msg user pending" data-pk="${k}">${imgs}${p.text ? `<div class="bubble">${tagChips(p.text, new Map(tagNums(p.text).map((n, j) => [n, p.imgs[j]]).filter(e => e[1]))).replace(/data-pn="(\d+)"/g, (m, n) => { const x = (p.pastes || []).find(y => y.n === +n); return x ? `${m} title="${escH(x.text.split('\n').slice(0, 8).join('\n'))}"` : m; })}</div>` : ''}<span class="q">${p.held ? 'Attaching…' : queued ? 'Queued' : 'Sending…'}${queued && p.text ? `<button type="button" class="q-x" data-unqueue="${k}" title="Take back (the agent keeps working)">Cancel</button>` : ''}</span></div>`;
    }).join('') + cliQueue(id, evs);
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
    // What was really sent (not the box as typed, with its chips), by its start: a long one shows in the CLI as a
    // "[Pasted text]" placeholder. Cleared with Backspace: the agent is working, and Ctrl+C would stop it.
    const sentOf = (o) => o.match || o.text, head = (o) => norm(sentOf(o)).slice(0, 24), erase = () => api.send({ type: 'termInput', id, data: '\x05' + '\x7f'.repeat(got.length + 40) });
    if (!got.includes(head(p)) && !/\[Pasted text/.test(got)) { erase(); return showToast('Already delivered to the agent'); } // ↑ recalled history instead: clear it
    erase(); await wait(250);
    if (box()) return showToast("Couldn't clear the agent's prompt; check the terminal");
    list.splice(k, 1);
    // The rest go back in the queue: only ones the CLI really had (by their start, or one "[Pasted text]" placeholder each
    // for a long one: only long text is collapsed), with their images. Ones still waiting in main's queue weren't
    // touched and go on their own.
    let placeholders = (got.match(/\[Pasted text #\d+/g) || []).length;
    if (sentOf(p).length > 800 && !got.includes(head(p))) placeholders--; // the cancelled one's own placeholder
    for (const o of list) {
      if (o.held || !sentOf(o)) continue;
      const had = got.includes(head(o)) || (sentOf(o).length > 800 && placeholders > 0 && placeholders--);
      if (had) { chatComposer.sendText(id, sentOf(o), (o.restore && o.restore.list) || []); await wait(400); }
    }
    rerender();
  }

  // ── Permission mode: read live from the CLI's footer ("bypass permissions on", "plan mode on", …), since the
  // transcript only records it once per turn. Picking one in the menu presses Shift+Tab until the footer shows it. ──
  const MODE_RE = [['bypassPermissions', /bypass\s*permissions\s*on/i], ['acceptEdits', /accept\s*edits\s*on/i], ['plan', /plan\s*mode\s*on/i], ['auto', /auto\s*mode\s*on/i]];
  function liveMode(id) {
    const rows = screenOf(id, 10); if (!rows) return null;
    const s = rows.join(' ');
    for (const [m, re] of MODE_RE) if (re.test(s)) return m;
    return /for\s*shortcuts|for\s*agents|\/effort/i.test(s) ? 'default' : null; // the input box's footer with no mode named in it ("? for shortcuts", now "← for agents")
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
  // Send a message (yours or a reply) to another agent: it arrives there as your message.
  function openFwdMenu(btn, text) {
    document.getElementById('chat-fwd-menu')?.remove();
    const list = [...agents].filter(([k, x]) => k !== selectedId && !x.archived && !x.dead);
    const m = document.createElement('div'); m.id = 'chat-fwd-menu'; m.setAttribute('role', 'menu');
    m.innerHTML = '<div class="mm-k">Send to</div>' + (list.length ? list.map(([k, x]) => `<button type="button" role="menuitem" class="mm-i" data-to="${k}">${ICON.agent}<span>${escH(x.title || 'Agent')} <small>${escH(String(x.cwd || '').split(/[\\/]/).pop())}</small></span></button>`).join('') : '<div class="mm-k">No other agents</div>');
    document.body.appendChild(m);
    const r = btn.getBoundingClientRect(), h = m.offsetHeight;
    m.style.left = Math.max(8, Math.min(r.right - m.offsetWidth, innerWidth - m.offsetWidth - 8)) + 'px';
    m.style.top = (r.bottom + 6 + h > innerHeight ? Math.max(8, r.top - 6 - h) : r.bottom + 6) + 'px';
    m.addEventListener('click', (e) => { const b = e.target.closest('[data-to]'); if (!b) return; const to = +b.dataset.to; m.remove(); chatComposer.sendText(to, text); chatUi.addPending(to, text); showToast('Sent to ' + ((agents.get(to) || {}).title || 'the agent')); });
    setTimeout(() => document.addEventListener('mousedown', function off(e) { if (!m.contains(e.target)) m.remove(); document.removeEventListener('mousedown', off, true); }, true), 0);
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
      // Everything uncommitted in the folder, one click away.
      + `<button type="button" class="chip icon" data-act="session-changes" title="Uncommitted changes in this folder">${ICON.diff}<span class="l">Changes</span></button>`
      + '<span class="grow"></span>'
      // Its @name, as the terminal shows it bottom-right: click copies it, to mention this agent (and its chat) elsewhere.
      + (a.agentName ? `<button type="button" class="chip name" data-act="copy-name" data-name="${escH(a.agentName)}" title="Copy @${escH(a.agentName)}: mention it in another agent to share this chat">@${escH(a.agentName)}</button>` : '')
      // Context left before auto-compact, once it matters (half used); click puts /compact in the box.
      + (pct >= 50 ? `<button type="button" class="chip ctx${pct > 80 ? ' hot' : ''}" data-insert="/compact" title="${pct}% of the context used. Click for /compact"><svg viewBox="0 0 18 18" aria-hidden="true"><circle cx="9" cy="9" r="${r}"/><circle class="v" cx="9" cy="9" r="${r}" stroke-dasharray="${((100 - pct) / 100 * c).toFixed(1)} ${c.toFixed(1)}"/></svg>${100 - pct}% left</button>` : '')
      + (model ? `<button type="button" class="chip model" data-act="model" aria-haspopup="menu" title="${escH(s.model)}">${escH(model)}${s.effort ? ` <em>${escH(s.effort)}</em>` : ''}</button>` : '')
      + `<button type="button" class="chip icon" data-act="view-menu" aria-haspopup="menu" title="Text size and shortcuts">${ICON.more}</button>`;
  }
  // ⋯ in the composer: text size (A− / A+, remembered) and the keyboard shortcuts.
  const ZOOMS = [0.9, 1, 1.1, 1.2, 1.35];
  let zoom = (() => { try { return +localStorage.getItem('chatZoom') || 1; } catch { return 1; } })();
  const applyZoom = () => document.documentElement.style.setProperty('--chat-zoom', zoom);
  applyZoom();
  const SHORTCUTS = [['Enter', 'Send'], ['Shift+Enter', 'New line'], ['Esc', 'Stop the agent'], ['↑ / ↓', 'Your earlier prompts'], ['@', 'Mention a file'], ['/', 'Commands and skills'], ['Ctrl+F', 'Find in chat'], ['Ctrl+↑ / ↓', 'Jump between prompts'], ['Ctrl+`', 'Chat ↔ terminal'], ['1–9', 'Answer a question card'], ['J / K', 'Files in the changes panel']];
  function openViewMenu(chip) {
    if (document.getElementById('chat-view-menu')) return closeViewMenu();
    const m = document.createElement('div'); m.id = 'chat-view-menu'; m.setAttribute('role', 'dialog'); m.setAttribute('aria-label', 'Chat options');
    // Agents waiting on you (questions, approvals, finished unseen), then view settings, then the shortcuts.
    let keysOpen = false;
    // Redrawing keeps keyboard focus on the same control (matched by its data-* and label), else the first one.
    const fkey = (b) => b ? [...b.attributes].filter(t => t.name.startsWith('data-') || t.name === 'aria-label').map(t => t.name + '=' + t.value).join('&') : '';
    const draw = () => {
      const had = m.contains(document.activeElement) ? fkey(document.activeElement) : null;
      render();
      if (had !== null) ([...m.querySelectorAll('button')].find(b => fkey(b) === had) || m.querySelector('button'))?.focus();
    };
    const render = () => {
      const items = inboxItems().filter(x => x.id !== selectedId), label = { question: 'Question', permission: 'Needs approval', done: 'Finished', crashed: 'Stopped' };
      const split = document.getElementById('term').classList.contains('split');
      // A waiting agent can be answered right here: Allow / Deny, or the question's options read off its terminal.
      // Each row: who, what kind, how long it's waited; under it the full command or question (what you'd be agreeing to),
      // then the answers, labelled with the agent's name for screen readers.
      const who = (x) => escH(x.a.title || 'Agent');
      const actions = (x) => x.kind === 'permission' ? `<span class="ib-a"><button type="button" class="primary" data-ans="${x.id}" data-k="1" aria-label="Allow ${who(x)}">Allow</button><button type="button" data-ans="${x.id}" data-k="esc" aria-label="Deny ${who(x)}">Deny</button></span>`
        : x.kind === 'question' ? `<span class="ib-a">${quickOpts(x.id).slice(0, 3).map((o, k) => `<button type="button" data-ans="${x.id}" data-pick="${k}" title="${escH(o)}" aria-label="Answer ${who(x)}: ${escH(o)}">${escH(o.length > 22 ? o.slice(0, 21) + '…' : o)}</button>`).join('')}</span>` : '';
      const waited = (x) => x.kind === 'done' ? '' : ` · <span data-since="${x.since}">waiting ${escH(dur(Date.now() - x.since))}</span>`;
      m.innerHTML = (items.length ? `<div class="vm-h">Needs you</div>${items.map(x => `<div class="ib-row"><button type="button" class="ib-i k-${x.kind}" data-agent="${x.id}" aria-label="Open ${who(x)}"><span class="ib-dot"></span><span class="ib-t"><b>${who(x)}</b><small>${escH(label[x.kind])}${waited(x)}</small></span></button>${x.what && x.kind !== 'done' && x.kind !== 'crashed' ? `<div class="ib-what" title="${escH(x.what)}">${escH(x.what)}</div>` : ''}${actions(x)}</div>`).join('')}<div class="vm-sep"></div>` : '')
        + `<div class="vm-row"><span>Text size</span><button type="button" data-z="-1" aria-label="Smaller">A−</button><b>${Math.round(zoom * 100)}%</b><button type="button" data-z="1" aria-label="Larger">A+</button></div>`
        + `<button type="button" class="vm-toggle" role="switch" aria-checked="${split}" data-split="1"><span>Terminal beside the chat</span><i class="${split ? 'on' : ''}"></i></button>`
        + `<button type="button" class="vm-toggle" aria-expanded="${keysOpen}" data-keys-list="1"><span>Keyboard shortcuts</span>${ICON.chev}</button>`
        + (keysOpen ? SHORTCUTS.map(([k, v]) => `<div class="vm-k"><span>${escH(v)}</span><kbd>${escH(k)}</kbd></div>`).join('') : '');
    };
    draw();
    m.addEventListener('click', (e) => {
      const an = e.target.closest('[data-ans]'); // answering a waiting agent from the menu: only while it still waits
      if (an) {
        const id = +an.dataset.ans; if (!stillWaiting(id)) { draw(); return; }
        if (an.dataset.k) { if (!menuUp(id)) { draw(); return; } api.send({ type: 'termInput', id, data: an.dataset.k === 'esc' ? '\x1b' : an.dataset.k }); }
        else if (!pickOption(id, +an.dataset.pick)) { closeViewMenu(); return; }
        // the row says what went through for a moment, then drops off the list
        const said = an.dataset.k === 'esc' ? 'Denied' : an.dataset.k ? 'Allowed' : 'Answered: ' + (an.title || an.textContent);
        const row = an.closest('.ib-row'); row?.querySelector('.ib-a')?.replaceWith(Object.assign(document.createElement('span'), { className: 'ib-ok', textContent: said }));
        announce(said); dropToast(id); setTimeout(draw, 1000); return;
      }
      const ag = e.target.closest('[data-agent]'); if (ag) { closeViewMenu(); focusAgent(+ag.dataset.agent); return; }
      if (e.target.closest('[data-split]')) { toggleSplit(); draw(); return; }
      if (e.target.closest('[data-keys-list]')) { keysOpen = !keysOpen; draw(); return; }
      const b = e.target.closest('[data-z]'); if (!b) return; const i = Math.max(0, Math.min(ZOOMS.length - 1, ZOOMS.indexOf(zoom) + +b.dataset.z)); zoom = ZOOMS[i] || 1; try { localStorage.setItem('chatZoom', zoom); } catch {} applyZoom(); draw();
    });
    // ↑/↓ move between the menu's buttons, Home/End jump to the ends
    m.addEventListener('keydown', (e) => {
      const bs = [...m.querySelectorAll('button')], i = bs.indexOf(document.activeElement);
      const to = e.key === 'ArrowDown' ? i + 1 : e.key === 'ArrowUp' ? i - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? bs.length - 1 : null;
      if (to === null || !bs.length) return;
      e.preventDefault(); bs[(to + bs.length) % bs.length].focus();
    });
    document.getElementById('term-order').appendChild(m);
    const r = chip.getBoundingClientRect(), o = document.getElementById('term-order').getBoundingClientRect();
    m.style.right = Math.max(0, o.right - r.right) + 'px';
    // Closes on a click outside or Esc (focus back to ⋯); "waiting 1m 4s" counts up while it's open.
    const off = (e) => { if (!m.contains(e.target) && !e.target.closest('[data-act="view-menu"]')) closeViewMenu(); };
    const esc = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeViewMenu(); chip.focus(); } };
    const timer = setInterval(() => { for (const s of m.querySelectorAll('[data-since]')) s.textContent = 'waiting ' + dur(Date.now() - +s.dataset.since); }, 1000);
    setTimeout(() => document.addEventListener('mousedown', off, true), 0);
    m.addEventListener('keydown', esc);
    // Tab past its last button closes it (it isn't modal), unless focus went to ⋯ itself
    m.addEventListener('focusout', (e) => { if (e.relatedTarget && !m.contains(e.relatedTarget) && e.relatedTarget !== chip) closeViewMenu(); });
    m._close = () => { clearInterval(timer); document.removeEventListener('mousedown', off, true); };
    m.querySelector('button')?.focus();
  }
  function closeViewMenu() { const m = document.getElementById('chat-view-menu'); if (m) { m._close?.(); m.remove(); } }

  // Draw the Chat view for agent a. Only blocks that changed are replaced, so a text selection and open rows
  // survive live ticks; new blocks slide in. Follows the bottom unless you scrolled up.
  let prevBusy = new Map(), tick = null, jumpOnce = false;
  // After you send: the bottom for a moment, through what still grows the thread (its bubble, markdown, images, blocks
  // getting their real height). Scrolling up yourself lets go.
  let pinUntil = 0;
  function pinBottom() {
    pinUntil = Date.now() + 2000; const el = document.getElementById('conversation');
    if (!el._pinWired) { el._pinWired = 1; el.addEventListener('wheel', (e) => { if (e.deltaY < 0) pinUntil = 0; }, { passive: true }); }
    const f = () => { if (Date.now() >= pinUntil || !el.classList.contains('open')) return; el.scrollTop = el.scrollHeight; requestAnimationFrame(f); };
    requestAnimationFrame(f);
  }
  // The reply still being written, off the agent's terminal screen (chat-core.js liveReply), until the transcript has it.
  const squash = (t) => String(t || '').replace(/[\s*_`#>•-]+/g, '');
  function screenReply(id, evs) {
    const rows = screenOf(id, 300, true); if (!rows) return '';
    const t = liveReply(rows); if (!t) return '';
    const head = squash(t).slice(0, 60);
    for (let k = evs.length - 1; k >= 0 && evs[k].type !== 'prompt'; k--) if (evs[k].type === 'text' && squash(evs[k].text).includes(head)) return ''; // landed already
    return t;
  }
  const liveKey = (h) => h.replace(/(data-live="[^"]*">)[^<]*/g, '$1');
  const srStatus = document.createElement('div'); srStatus.id = 'chat-sr'; srStatus.setAttribute('role', 'status'); srStatus.setAttribute('aria-live', 'polite'); srStatus.className = 'sr-only'; document.body.appendChild(srStatus);
  function announce(t) { if (srStatus.textContent !== t) srStatus.textContent = t; }
  function paint(el, id, a, evs, st) {
    const now = Date.now();
    evs = evs && viewEvs(a, evs); // a message you edited, and what answered it, are gone from the thread (or shown as a version)
    const doneBy = new Map(); let mode = '';
    if (evs) for (const ev of evs) { if (ev.type === 'tool_done' && ev.toolId) doneBy.set(ev.toolId, ev); else if (ev.type === 'mode') mode = ev.mode; }
    mode = liveMode(id) || mode; // the footer is current; the transcript only notes the mode once per turn
    // The transcript outranks a stale "working": a turn whose end is the last thing written is over, whatever a
    // leftover per-call status in the list says.
    // (Covers "resuming" too: it can linger after Overlord reattaches an agent that has since finished.)
    // …unless a message of yours is on its way: that started a new turn the transcript hasn't written yet.
    if (evs && !(pending.get(id) || []).some(p => !p.held) && (st === 'active' || st === 'settling' || st === 'resuming')) { for (let k = evs.length - 1; k >= 0; k--) { const t = evs[k].type; if (t === 'mode' || t === 'tool_done' || t === 'images' || t === 'queue') continue; if (t === 'turn' || t === 'interrupt') st = 'waiting'; break; } }
    // Esc: stopped now, as in the CLI, not when the transcript catches up. Should the agent still be at work 8 s later
    // (the Esc didn't land), it shows as working again.
    const stopped = !!(a._stopAt && now - a._stopAt < 8000 && (st === 'active' || st === 'settling' || st === 'resuming'));
    if (stopped) st = 'waiting';
    // The CLI's own screen outranks a stale "working" too (seen after a resume): no spinner ("esc to interrupt") for 3 s
    // while nothing of yours is on its way, and it isn't working.
    // A Claude that died mid-turn (crash, app or PC restart) leaves its last spinner frozen on screen, but a working one
    // redraws it at least every second: nothing from its terminal for 10 s, or its terminal gone, and it isn't working.
    if ((st === 'active' || st === 'resuming') && !(pending.get(id) || []).some(p => !p.held)) {
      const rows = screenOf(id, 14, true), heard = typeof lastTermDataAt !== 'undefined' ? lastTermDataAt.get(id) || 0 : now;
      if (a.dead || (a.crashed !== 'resuming' && now - heard > 10000)) st = 'waiting';
      else if (rows && rows.length && !/esc to interrupt|…\s*\(/i.test(rows.join('\n'))) { if (!a._idleSeen) a._idleSeen = now; if (now - a._idleSeen > 3000) st = 'waiting'; }
      else a._idleSeen = 0;
    } else a._idleSeen = 0;
    const busy = st === 'active' || st === 'resuming';
    const order = document.getElementById('term-order');
    order.classList.toggle('busy', busy); order.classList.toggle('dead', a.crashed === 'fatal');
    const chips = document.getElementById('chat-chips'); if (chips) { const ch = chipsHtml(a, mode); if (chips._h !== ch) chips.innerHTML = chips._h = ch; }
    let list;
    if (!evs) list = ['<div class="chat-empty"><span class="loading"></span></div>'];
    else if (!evs.length) list = [`<div class="chat-empty hello">${SPARK}<div>What are we building?</div></div>`];
    else list = blocks(evs, doneBy, a.cwd, id);
    if (busy && !prevBusy.get(id)) a._tok0 = (a.stats && a.stats.outTok) || 0; // tokens are counted from the turn's start
    dockHtml = ''; dockCount = { agents: 0, shells: 0 };
    // Until the transcript writes its own interrupt note for this turn, the chat shows one.
    const noted = evs && (() => { for (let k = evs.length - 1; k >= 0; k--) { if (evs[k].type === 'interrupt') return true; if (evs[k].type === 'prompt') return false; } return false; })();
    const stopNote = a._stopAt && now - a._stopAt < 8000 && evs && !noted && !(a._reverted && now - a._reverted < 8000) && (stopped || st === 'waiting') ? '<div class="msg note">⎿ Interrupted</div>' : '';
    const tail = (evs ? stopNote + pendingHtml(id, evs, busy) + liveHtml(a, st, evs, doneBy, now) + (busy || st === 'question' || st === 'permission' || (pending.get(id) || []).length ? '' : qrHtml(evs)) : ''); // queued text waits above the spinner or an open question, as in the CLI

    let thread = el.querySelector(':scope > .thread'), tailEl = el.querySelector(':scope > .tail');
    const fresh = el.dataset.for !== String(id) || !thread;
    if (fresh && window.chatComposer) chatComposer.drawAtt(); // another agent: its own pending images
    if (fresh && el._agent != null && el._agent !== id) onAgentSwitch(); el._agent = id;
    if (fresh) { el.innerHTML ='<div class="thread"></div><div class="tail"></div>'; thread = el.firstChild; tailEl = el.lastChild; el._blocks = []; el.dataset.for = String(id); el._shown = null; }
    // The history landing after the loading spinner is opening the chat too: always at the bottom, nothing slides in
    // (else the last reply counted as "just arrived" and a long one parked you at its first line).
    const opening = fresh || (!!evs && el._shown !== id); if (evs) el._shown = id;
    const stuck = !opening && !jumpOnce && Date.now() >= pinUntil && el.scrollTop + el.clientHeight < el.scrollHeight - 40;
    const old = el._blocks || [];
    let newReply = null; const changed = []; // only these get the link, image and diagram passes below (a long chat is thousands of nodes)
    for (let k = 0; k < list.length; k++) {
      if (old[k] === list[k]) continue;
      const tmp = document.createElement('div'); tmp.innerHTML = list[k];
      const node = tmp.firstElementChild || document.createElement('div');
      const cur = thread.children[k];
      changed.push(node);
      if (cur) { keepOpen(cur, node); cur.replaceWith(node); }
      else { if (!opening) node.classList.add('enter'); if (!opening && node.classList.contains('turnfoot') && prevBusy.get(id)) node.classList.add('landed'); thread.appendChild(node); if (!opening && node.classList.contains('ai')) newReply = node; }
    }
    while (thread.children.length > list.length) thread.lastElementChild.remove();
    el._blocks = list;
    // The live tail ticks every second (elapsed, the CLI's verb, agent timers). When only that text changed, swap the
    // text in place: rebuilding would replay the slide-in and restart the spark and shimmer on every tick.
    if (tailEl._h !== tail) {
      const key = liveKey(tail);
      if (tailEl._k === key) { const tmp = document.createElement('div'); tmp.innerHTML = tail; for (const n of tmp.querySelectorAll('[data-live]')) { const c = tailEl.querySelector(`[data-live="${CSS.escape(n.dataset.live)}"]`); if (c && c.textContent !== n.textContent) c.textContent = n.textContent; } }
      else { tailEl.innerHTML = tail; if (opening) for (const n of tailEl.children) n.classList.add('still'); } // opening a chat: there already, nothing slides in
      tailEl._h = tail; tailEl._k = key; changed.push(tailEl);
    }
    drawDock(); applyAskHover(); keepAskInput(); // a hovered option keeps its preview through redraws, a typed answer its text
    const lr = tailEl.querySelector('.live-reply'); if (lr) { const t = busy ? screenReply(id, evs) : ''; if (lr._t !== t) { lr._t = t; lr.textContent = t; lr.hidden = !t; } }
    announce(st === 'question' ? 'The agent has a question' : st === 'permission' ? 'The agent needs approval' : busy ? 'The agent is working' : a.crashed === 'fatal' ? 'The agent stopped' : 'The agent is done');
    prevBusy.set(id, busy);
    // The working line's elapsed time ticks once a second while the agent works and the view is open.
    if (busy && !tick) tick = setInterval(() => { if (!el.classList.contains('open')) { clearInterval(tick); tick = null; return; } rerender(); }, 1000);
    else if (!busy && tick) { clearInterval(tick); tick = null; }
    // A long reply that just arrived: land on its first line, to read it top-down (from then on you're "scrolled up",
    // so the live ticks leave it there).
    if (!stuck && !jumpOnce && Date.now() >= pinUntil && newReply && newReply.offsetHeight > el.clientHeight * 0.6) el.scrollTop += newReply.getBoundingClientRect().top - el.getBoundingClientRect().top - 24;
    else if (!stuck) {
      el.scrollTop = el.scrollHeight;
      // Images grow the thread as they load: stay pinned to the bottom through that.
      for (const i of changed.flatMap(n => [...n.querySelectorAll('img')])) if (!i.complete && !i._pin && (i._pin = 1)) i.addEventListener('load', () => { if (el.scrollHeight - el.scrollTop - el.clientHeight < i.offsetHeight + 120) el.scrollTop = el.scrollHeight; }, { once: true });
    }
    jumpOnce = false;
    // What ticks (running calls, usage-limit cards) is in the last few blocks.
    const recent = [...thread.children].slice(-12), inRecent = (sel) => recent.flatMap(n => [...n.querySelectorAll(sel)]);
    for (const s of inRecent('.trow.running .el')) s.textContent = '· ' + dur(now - +s.dataset.t); // running calls tick in place
    // Usage-limit cards: the countdown, Retry held until the reset, and the retry the user asked for once it's passed.
    for (const s of inRecent('.countdown[data-reset]')) { const left = +s.dataset.reset - now; s.textContent = left > 0 ? 'in ' + dur(left) : 'now'; }
    for (const b of inRecent('button[data-reset]')) b.disabled = +b.dataset.reset > now;
    for (const c of inRecent('input[data-autoretry]')) c.checked = autoRetry.has(id + ':' + c.dataset.autoretry);
    for (const key of [...autoRetry]) { const [aid, at] = key.split(':').map(Number); if (aid !== id || at > now) continue; autoRetry.delete(key); const t = [...evs].reverse().find(e => e.type === 'prompt' && e.text); if (t) chatComposer.sendText(id, t.text); } // only this agent's: each agent remembers its own
    if (autoRetry.size && !retryTimer) retryTimer = setInterval(() => { if (!autoRetry.size) { clearInterval(retryTimer); retryTimer = null; } else rerender(); }, 30000);
    drawRail(el, evs);
    drawDiagrams(changed);
    prettyLinks(changed);
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
  // Scroll fires many times a frame: the measuring waits for the next frame, once.
  let jumpRaf = 0;
  function syncJump(el) { if (!jumpRaf) jumpRaf = requestAnimationFrame(() => { jumpRaf = 0; const b = document.getElementById('chat-jump'); if (b) b.classList.toggle('show', el.scrollTop + el.clientHeight < el.scrollHeight - 40); railActive(el); }); }

  // ── Prompt rail, as on the terminal: a dash per prompt down the right edge, hover lists them, click jumps there ──
  const rail = document.createElement('div'); rail.id = 'chat-rail'; rail.innerHTML = '<div class="cr-dashes"></div><div class="cr-pop"></div>';
  document.getElementById('term').appendChild(rail);
  // ```mermaid blocks in a reply draw as diagrams (flowchart, sequence, pie, xychart, gantt…). mermaid.min.js (2.5 MB)
  // loads the first time one shows up; each source's SVG is kept, so a redrawn block doesn't render it again. The
  // source stays under it, hidden, for Copy; a block that fails to parse stays code.
  let mermaidLoad = null, mermaidSeq = 0;
  const svgOf = new Map();
  // ── A link's readable name: a ClickUp task by its real name (the board Overlord holds, else one fetch), a GitHub PR or
  // issue as "repo #N", anything else as site + path. Shared by the thread and the reply box's link chips. ──
  const taskNames = new Map(); // ClickUp task id → name ('' while asked, null when it can't be read)
  const linkWaiters = new Set();
  function linkLabel(u) {
    const cu = (/app\.clickup\.com\/t\/(?:\d+\/)?([\w-]+)/.exec(u) || [])[1];
    if (cu) {
      const known = typeof clickupState !== 'undefined' && clickupState.tasks.find(t => t.id === cu);
      if (known) taskNames.set(cu, known.name);
      if (!taskNames.has(cu)) { taskNames.set(cu, ''); api.send({ type: 'clickupTask', id: cu }); }
      // Its name needs ClickUp connected in Overlord (the page is behind a login); until then its id tells links apart.
      const cmt = /[?&]comment=/.test(u) ? ' · comment' : '', n = taskNames.get(cu);
      return { kind: 'cu', id: cu, name: (n || 'ClickUp ' + cu) + cmt, sub: n ? 'ClickUp · ' + cu : n === null && typeof clickupHasToken !== 'undefined' && !clickupHasToken ? 'Connect ClickUp in Settings to show its name' : 'ClickUp' };
    }
    let p; try { p = new URL(u); } catch { return null; }
    // The page's own title once main has it (a browser tab's: gh for a PR or issue, else the page's <title>).
    if (!pageTitles.has(u) && /^https:/.test(u)) { pageTitles.set(u, ''); api.send({ type: 'linkTitle', url: u }); }
    const title = pageTitles.get(u);
    const gh = p.hostname === 'github.com' && /^\/[^/]+\/([^/]+)\/(pull|issues)\/(\d+)/.exec(p.pathname);
    if (gh) return { kind: 'gh', name: title || `${gh[1]} #${gh[3]}`, sub: `${gh[1]} #${gh[3]}` };
    return { kind: 'web', name: title || p.hostname.replace(/^www\./, '') + ((p.pathname + p.search).replace(/^\/$/, '').slice(0, 40)), sub: p.hostname };
  }
  const pageTitles = new Map(); // url → page title ('' while asked or when it has none)
  function onLinkTitle(msg) { if (pageTitles.get(msg.url) === msg.title) return; pageTitles.set(msg.url, msg.title || ''); if (msg.title) for (const fn of linkWaiters) fn(); }
  function onTask(msg) {
    if (!taskNames.has(msg.id) || taskNames.get(msg.id)) return;
    taskNames.set(msg.id, msg.task ? msg.task.name : null);
    for (const fn of linkWaiters) fn();
  }
  // Bare links in the thread (a reply's autolinks, a /command's arguments) read by name; hover shows the address.
  // roots: the blocks just drawn; a title that came in later relabels the whole chat (relabel).
  function prettyLinks(roots, relabel) {
    for (const a of roots.flatMap(r => [...r.querySelectorAll('a[href^="http"]:not([data-pl])')])) {
      if (a.textContent.trim() !== a.getAttribute('href') && a.textContent.trim() !== (() => { try { return decodeURI(a.getAttribute('href')); } catch { return ''; } })()) { a.dataset.pl = '0'; continue; }
      const l = linkLabel(a.getAttribute('href')); if (!l) { a.dataset.pl = '0'; continue; }
      a.dataset.pl = l.kind; if (l.id) a.dataset.cu = l.id; a.title = a.getAttribute('href') + (l.sub.startsWith('Connect') ? '\n' + l.sub : '');
      a.classList.add('plink'); a.textContent = l.name;
    }
    if (relabel) for (const a of roots.flatMap(r => [...r.querySelectorAll('a.plink')])) { const l = linkLabel(a.getAttribute('href')); if (l && a.textContent !== l.name) a.textContent = l.name; } // a title or name that came in since
  }
  linkWaiters.add(() => { const el = document.getElementById('conversation'); if (el) prettyLinks([el], true); });
  function drawDiagrams(roots) {
    const blocks = roots.flatMap(r => [...r.querySelectorAll('.md-code:not(.drawn)')]).filter(b => b.querySelector('.md-code-head span')?.textContent === 'mermaid');
    if (!blocks.length) return;
    mermaidLoad ||= new Promise((res, rej) => { const s = document.createElement('script'); s.src = './mermaid.min.js'; s.onload = res; s.onerror = rej; document.head.appendChild(s); });
    mermaidLoad.then(async () => {
      // Drawn in the app's own colours and UI font (a real font name: mermaid measures labels with it, so 'inherit' clips them).
      const cs = getComputedStyle(document.documentElement), v = (n) => cs.getPropertyValue(n).trim();
      const dark = (() => { const c = getComputedStyle(document.body).backgroundColor.match(/\d+/g) || [255, 255, 255]; return (+c[0] * 0.3 + +c[1] * 0.59 + +c[2] * 0.11) < 128; })();
      const pal = ['#d97757', '#6a9bcc', '#788c5d', '#c46686', '#e0b04c', '#8e7cc3', '#4fa3a5', '#b0aea5'];
      window.mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'base', htmlLabels: false, flowchart: { htmlLabels: false }, // HTML labels measure short in Electron and lose their last letter
         fontFamily: getComputedStyle(document.body).fontFamily, themeVariables: {
        darkMode: dark, fontSize: '14px', background: 'transparent', primaryColor: v('--surface1'), primaryBorderColor: v('--border-hi'), primaryTextColor: v('--text'),
        secondaryColor: v('--surface0'), tertiaryColor: v('--surface0'), lineColor: v('--subtext'), textColor: v('--text'), mainBkg: v('--surface1'), nodeBorder: v('--border-hi'),
        edgeLabelBackground: v('--bg'), actorBkg: v('--surface1'), actorBorder: v('--border-hi'), actorTextColor: v('--text'), signalColor: v('--subtext'), signalTextColor: v('--text'),
        noteBkgColor: v('--surface0'), noteTextColor: v('--text'), pieStrokeColor: v('--bg'), pieOuterStrokeColor: v('--bg'), pieTitleTextColor: v('--text'), pieLegendTextColor: v('--text'), pieSectionTextColor: '#fff', pieOpacity: '1',
        ...Object.fromEntries(pal.map((c, i) => ['pie' + (i + 1), c])),
        xyChart: { backgroundColor: 'transparent', titleColor: v('--text'), xAxisLabelColor: v('--subtext'), yAxisLabelColor: v('--subtext'), xAxisTitleColor: v('--subtext'), yAxisTitleColor: v('--subtext'), xAxisLineColor: v('--border-hi'), yAxisLineColor: v('--border-hi'), xAxisTickColor: v('--border-hi'), yAxisTickColor: v('--border-hi'), plotColorPalette: pal.join(',') },
      } });
      for (const b of blocks) {
        if (b.classList.contains('drawn')) continue;
        const src = b.querySelector('code').textContent, key = (dark ? 'd:' : 'l:') + src;
        try {
          if (!svgOf.has(key)) svgOf.set(key, (await window.mermaid.render('chat-mm-' + ++mermaidSeq, src)).svg);
          const fig = document.createElement('div'); fig.className = 'md-diagram'; fig.innerHTML = svgOf.get(key);
          const atEnd = el.scrollHeight - el.scrollTop - el.clientHeight < 80; // following the bottom: keep following as it grows
          b.querySelector('pre').before(fig); b.classList.add('drawn');
          if (atEnd) el.scrollTop = el.scrollHeight;
        } catch { b.classList.add('drawn', 'bad'); document.getElementById('dchat-mm-' + mermaidSeq)?.remove(); } // mermaid leaves its error SVG in <body>
      }
    }, () => {});
  }
  function drawRail(el, evs) {
    const mk = marksOf(selectedId); // bookmarked replies sit on the rail too, starred
    const ps = (evs || []).map((e, i) => [e, i]).filter(([e]) => e.type === 'prompt' || e.type === 'command' || (e.type === 'text' && e.ts && mk.has(e.ts)));
    const key = ps.map(([e, i]) => i + (e.type === 'text' ? '*' : '')).join(',');
    rail.classList.toggle('has', ps.length > 1);
    if (rail._k === key) return; rail._k = key; rail._on = undefined; // new dashes: light the current one again
    const label = (t) => escH(String(t || '').replace(/\[Image #\d+\]/g, '🖼').replace(/[#*`>_]/g, '').replace(/\s+/g, ' ').trim().slice(0, 140) || '🖼');
    rail.querySelector('.cr-dashes').innerHTML = ps.map(([e, i]) => `<i data-i="${i}"${e.type === 'text' ? ' class="mark"' : ''}></i>`).join('');
    rail.querySelector('.cr-pop').innerHTML = ps.map(([e, i]) => `<div data-i="${i}"${e.type === 'text' ? ' class="mark"' : ''}>${e.type === 'text' ? '★ ' : ''}${label(e.text)}</div>`).join('');
    railActive(el);
  }
  // The prompt at the top of the view is the one lit.
  function railActive(el) {
    if (!rail.classList.contains('has')) return;
    const top = el.getBoundingClientRect().top + 40; let on = null;
    for (const u of el.querySelectorAll('.thread > .msg.user[data-i], .thread > .msg.cmd[data-i]')) { if (u.getBoundingClientRect().top <= top) on = u.dataset.i; else break; }
    if (on == null) { const f = el.querySelector('.thread > .msg.user[data-i]'); on = f && f.dataset.i; }
    if (rail._on === on) return; rail._on = on; // same prompt as last time: nothing to move
    for (const n of rail.querySelectorAll('[data-i]')) n.classList.toggle('on', n.dataset.i === on);
  }
  let scrubEnd = 0;
  rail.addEventListener('click', (e) => {
    const t = e.target.closest('[data-i]'); if (!t || Date.now() - scrubEnd < 300) return;
    const go = () => { const m = document.querySelector(`#conversation .thread > [data-i="${t.dataset.i}"]`); if (m) { m.scrollIntoView({ block: 'start', behavior: 'smooth' }); m.classList.remove('flash'); void m.offsetWidth; m.classList.add('flash'); } return !!m; };
    if (!go()) { expanded.add(selectedId); rerender(); setTimeout(go, 50); } // it's in the folded earlier turns: open them first
  });
  rail.addEventListener('mouseenter', () => { const on = rail.querySelector('.cr-pop .on'); if (on) on.scrollIntoView({ block: 'nearest' }); });
  // Drag along the dashes to scrub: the chat follows to each prompt the pointer passes, at once (no smooth scroll).
  let scrub = null; // { last, moved } while the pointer is held on the rail
  const scrubTo = (y) => {
    const ds = [...rail.querySelectorAll('.cr-dashes [data-i]')]; if (!ds.length) return;
    const d = ds.reduce((b, n) => { const r = n.getBoundingClientRect(), dy = Math.abs(r.top + r.height / 2 - y); return dy < b[0] ? [dy, n] : b; }, [Infinity, null])[1];
    if (!d || d.dataset.i === scrub.last) return;
    scrub.last = d.dataset.i; scrub.moved = true;
    let m = document.querySelector(`#conversation .thread > [data-i="${d.dataset.i}"]`);
    if (!m && !expanded.has(selectedId)) { expanded.add(selectedId); rerender(); m = document.querySelector(`#conversation .thread > [data-i="${d.dataset.i}"]`); } // folded earlier turns: open them
    if (m) m.scrollIntoView({ block: 'start', behavior: 'auto' });
  };
  rail.querySelector('.cr-dashes').addEventListener('pointerdown', (e) => { if (e.button) return; scrub = { last: null, moved: false }; rail.setPointerCapture(e.pointerId); rail.classList.add('scrub'); scrubTo(e.clientY); e.preventDefault(); });
  rail.addEventListener('pointermove', (e) => { if (scrub) scrubTo(e.clientY); });
  const endScrub = () => { if (!scrub) return; const moved = scrub.moved; scrub = null; rail.classList.remove('scrub'); if (moved) scrubEnd = Date.now(); }; // the release isn't also a click
  rail.addEventListener('pointerup', endScrub); rail.addEventListener('pointercancel', endScrub);

  // Keys typed into the agent's terminal one write at a time, so the TUI reads each as its own key press.
  // Stop the turn: Esc to the CLI, and the chat says so at once instead of waiting for the transcript.
  function stop(revert = true) {
    const id = selectedId, a = agents.get(id); if (!a) return;
    a._stopAt = Date.now();
    // Main stops what it hasn't handed the CLI yet, then sends the Esc once no paste is half-written (straight to the
    // CLI it could land inside a long paste as text).
    api.send({ type: 'cliCancel', id });
    if (!revert) {
      // Editing stops the turn itself: its new message stays (the last one waiting), no "Interrupted". Earlier ones main
      // had not handed over yet were just cancelled: they come back to the box, never lost.
      const pend = pending.get(id) || [], keep = pend[pend.length - 1], others = pend.slice(0, -1).filter(p => !p.held);
      if (others.length) {
        pending.set(id, pend.filter(p => p.held || p === keep));
        if (others.length === 1 && others[0].restore) chatComposer.restoreDraft(id, others[0].restore); // whole, images and all
        else appendDraft(id, others.map(p => p.match || p.text).join('\n\n'));
      }
      a._reverted = Date.now(); return rerender();
    }
    // Esc before Claude answered: as in the CLI, your messages come back to the box and leave the thread. Messages still
    // on their way come back at once. One the CLI already has comes back only if the CLI itself put it back in its box
    // (it does when nothing was answered yet); that box is then cleared, or it would ride along with the next send.
    const evs = visibleEvs(a, worldTl && worldTl.id === id ? worldTl.events : []), pend = pending.get(id) || [];
    // A tool call already under way doesn't count as an answer: the CLI still puts the message back (no text written yet).
    let k = evs.length - 1; while (k >= 0 && /^(mode|images|interrupt|tool|tool_done|subtask|queue)$/.test(evs[k].type)) k--;
    const last = evs[k], lastMine = last && (last.type === 'prompt' || last.type === 'command') && last.ts && Date.now() - Date.parse(last.ts) < 120000 && !screenReply(id, evs) ? last : null;
    const back = pend.filter(p => !p.held);
    if (back.length) {
      pending.set(id, pend.filter(p => p.held)); a._reverted = Date.now();
      // one comes back whole (images, pasted texts, files, links); several as their text, in order
      if (back.length === 1 && back[0].restore) chatComposer.restoreDraft(id, back[0].restore);
      else appendDraft(id, back.map(p => p.match || p.text).join('\n\n'));
    }
    if (lastMine && !a._takeBack) a._takeBack = afterEsc(id, () => { // one check per Esc burst: a second Esc doesn't take it back twice
      a._takeBack = null;
      // the CLI put it back in its box (as itself, or as its "[Pasted text]" placeholder when long): it's out of the conversation
      const x = typeof xterms !== 'undefined' && xterms.get(id), inBox = x && typeof readPromptBox === 'function' ? readPromptBox(x.terminal) : '';
      const head = String(lastMine.text || '').replace(/\s+/g, ' ').trim().slice(0, 24).toLowerCase();
      const back2 = inBox.replace(/\s+/g, ' ').toLowerCase().includes(head) || (/^\s*\[Pasted text #\d+/.test(inBox) && String(lastMine.text || '').length > 200);
      if (!head || !back2) return rerender();
      // its [Image #N] tags are the CLI's, not pictures this box holds: out, or they'd take the restored message's images
      const mine = String(lastMine.text || '').replace(/\[Image #\d+\]\s*/g, '').trim();
      if (!mine) return rerender(); // only an image: the CLI's box is all that still holds it, so it stays there and in the thread
      a._reverted = Date.now();
      setHides(a, [...hidesOf(a), { from: Date.parse(lastMine.ts), until: Date.now() }]);
      // in front of what's in that agent's box (anything still on its way, or what you've typed since), whichever agent is on screen
      const cur = chatComposer.getDraft(id);
      chatComposer.setDraft(id, cur.trim() ? mine + '\n\n' + cur : mine);
      chatComposer.clearCliBox(id); rerender();
    });
    else if (back.length) afterEsc(id, () => chatComposer.clearCliBox(id));
    rerender();
  }
  // Run fn 700 ms after main reports this agent's Esc was really written (a long paste in progress holds it back; the
  // CLI needs a moment to put a message back in its box). Main not answering within 4 s: run it anyway.
  const escWaiters = new Map(); // agent id → [fn]
  function afterEsc(id, fn) {
    const list = escWaiters.get(id) || []; list.push(fn); escWaiters.set(id, list);
    setTimeout(() => { const l = escWaiters.get(id); if (l && l.includes(fn)) { l.splice(l.indexOf(fn), 1); fn(); } }, 4000);
    return true;
  }
  function onEscSent(id) { const l = escWaiters.get(id) || []; escWaiters.delete(id); for (const fn of l) setTimeout(fn, 700); }
  // Text into an agent's reply box, after what's already there.
  function appendDraft(id, text) { const box = document.getElementById('term-order-input'), cur = id === selectedId ? box.value : ''; chatComposer.setDraft(id, cur.trim() ? cur.replace(/\s*$/, '\n') + text : text); }
  function keys(list) { const id = selectedId; list.forEach((k, n) => setTimeout(() => api.send({ type: 'termInput', id, data: k }), n * 70)); }
  // Option k of an open question: its number key, as in the terminal, so it lands wherever the CLI's cursor sits.
  // A multi-select box ("[ ] Postgres") only toggles and "Type something" waits for typing: those go to the terminal.
  const oneKey = (o) => !/^\s*(\[[ x✓✔]?\]|[☐☑◯◉○●])/i.test(o) && !/^type something/i.test(o);
  const quickOpts = (id) => { const o = menuOptions(id); return o.every(oneKey) ? o : o.some(x => !oneKey(x) && /^\s*(\[|[☐☑◯◉○●])/.test(x)) ? [] : o.filter(oneKey); };
  function pickOption(id, k) {
    const o = menuOptions(id)[k];
    if (k < 9 && (o === undefined || oneKey(o))) { api.send({ type: 'termInput', id, data: String(k + 1) }); return true; }
    // "Type something": your answer goes in the reply box (sending it picks that option, then types it).
    if (/^type something/i.test(o)) { if (selectedId !== id) focusAgent(id); if (termTab !== 'conversation') switchTermTab('conversation'); document.getElementById('term-order-input').focus(); return false; }
    focusAgent(id); switchTermTab('terminal'); return false; // answer it where it can be answered
  }

  // Clicks inside the view and on the composer chips.
  function onClick(e, a, evs) {
    if (a && evs) evs = viewEvs(a, evs); // the blocks' data-i count the list paint drew, hidden messages left out
    const cwd = a && a.cwd;
    const k = e.target.closest('[data-keys]'); // permission card: the same keys the terminal menu takes
    // Only while it still waits: a second click, or a card answered in the terminal, never types into a live prompt.
    if (k && selectedId != null) { if (stillWaiting(selectedId) && menuUp(selectedId)) keys([k.dataset.keys === 'esc' ? '\x1b' : k.dataset.keys]); return; }
    const rw = e.target.closest('[data-rw], [data-rwx]'); // rewind card: a point, or Cancel (Esc, as in the CLI)
    if (rw && selectedId != null) { if (rw.dataset.rwx) { keys(['\x1b']); setTimeout(rerender, 300); } else rewindPick(+rw.dataset.rw); return; }
    const tab = e.target.closest('.ask-tabs [data-tab]'); // another of its questions
    if (tab) { askTab(+tab.dataset.tab - +tab.parentElement.dataset.on); return; }
    const pick = e.target.closest('[data-pick]'); // question card: the option's number key
    if (pick && e.target.closest('.ask-in')) return; // typing an answer in it
    // A box of a pick-several question: its number toggles it, as in the CLI; the card stays for the rest and Submit.
    if (pick && selectedId != null && isBox(menuOptions(selectedId)[+pick.dataset.pick])) { keys([String(+pick.dataset.pick + 1)]); setTimeout(rerender, 350); return; }
    // "Type something": the row becomes where you type, as in the CLI (its cursor goes there too).
    if (pick && selectedId != null && /^type something/i.test(menuOptions(selectedId)[+pick.dataset.pick] || '')) { askMove(+pick.dataset.pick); askFocusIn = true; rerender(); return; }
    if (pick && selectedId != null) { if ((stillWaiting(selectedId) || screenAsk(selectedId).dialog) && !pick.closest('.picked-card') && pickOption(selectedId, +pick.dataset.pick)) { pick.classList.add('picked'); pick.closest('.card')?.classList.add('picked-card'); } return; }
    const tag = e.target.closest('.imgtag[data-src]'); // an [Image #N] chip opens the image it names
    if (tag) { lightbox(tag.dataset.src); return; }
    const img = e.target.closest('.imgs img'); // a thumbnail opens full size
    if (img) { lightbox(img.src); return; }
    const ar = e.target.closest('input[data-autoretry]'); // "Retry when it resets"
    if (ar) { const key = selectedId + ':' + ar.dataset.autoretry; ar.checked ? autoRetry.add(key) : autoRetry.delete(key); rerender(); return; }
    const uq = e.target.closest('[data-unqueue]'); // ✕ on a queued prompt: take it back, the agent keeps working
    if (uq) { unqueue(selectedId, +uq.dataset.unqueue); return; }
    const art = e.target.closest('[data-art-open], [data-art-copy]'); // an Artifact card: open the page, or copy its link
    if (art) { if (art.dataset.artOpen) api.send({ type: 'openUrl', url: art.dataset.artOpen }); else navigator.clipboard.writeText(art.dataset.artCopy).then(() => { art.classList.add('done'); setTimeout(() => art.classList.remove('done'), 1200); }); return; }
    const pn = e.target.closest('[data-pn]'); // a pasted text's chip in a message on its way: its text in the panel
    if (pn) { const k = pn.closest('[data-pk]'), p = k && (pending.get(selectedId) || [])[+k.dataset.pk], x = p && (p.pastes || []).find(y => y.n === +pn.dataset.pn); if (x) openText(`Pasted text #${x.n} · ${x.lines} lines`, x.text); return; }
    const sh = e.target.closest('[data-bgout]'); // a background shell's chip: its live output
    if (sh) { openShell(sh.dataset.bgout, sh.dataset.bgname); return; }
    const ag = e.target.closest('[data-agent-tid], [data-jump]'); // an agent's row or chip: its steps in a panel
    if (ag) { openAgent(ag.dataset.agentTid || ag.dataset.jump, evs || []); return; }
    const ins = e.target.closest('[data-insert]'); // composer chips: /compact, /model
    if (ins) { chatComposer.insert(ins.dataset.insert, false); return; }
    const qr = e.target.closest('[data-qr]'); // a one-click answer: sent as your message (into the box beside a draft)
    if (qr) { const box = document.getElementById('term-order-input'); if (box.value.trim()) chatComposer.insert(qr.dataset.qr, false); else { box.value = qr.dataset.qr; sendOrder(); } return; }
    const act = e.target.closest('[data-act]');
    if (act) {
      const lastPrompt = () => { for (let k = (evs || []).length - 1; k >= 0; k--) if ((evs[k].type === 'prompt' || evs[k].type === 'command') && evs[k].text) return evs[k].text; return ''; };
      if (act.dataset.act === 'resume') resumeSelected();
      else if (act.dataset.act === 'copy-name') navigator.clipboard.writeText('@' + act.dataset.name).then(() => showToast(`Copied @${act.dataset.name}`), () => {});
      else if (act.dataset.act === 'retry') { const t = lastPrompt(); if (t) { chatComposer.sendText(selectedId, t); chatUi.addPending(selectedId, t); rerender(); } }
      else if (act.dataset.act === 'edit-prompt') { // the bubble becomes its own editor
        const i = +act.closest('[data-i]').dataset.i, ev = (evs || [])[i];
        if (ev && (ev.type === 'prompt' || ev.type === 'command')) { editing = { id: selectedId, i, ts: ev.ts, text: ev.text }; rerender(); setTimeout(() => { const ta = document.querySelector('#conversation .msg.editing .edit-ta'); if (ta) { ta.focus(); ta.selectionStart = ta.selectionEnd = ta.value.length; ta.style.height = ta.scrollHeight + 'px'; } }, 30); }
      }
      else if (act.dataset.act === 'fwd') { const ev = (evs || [])[+act.closest('[data-i]').dataset.i]; if (ev && ev.text) openFwdMenu(act, ev.text); }
      else if (act.dataset.act === 'edit-cancel') { editing = null; rerender(); }
      else if (act.dataset.act === 'edit-send') {
        const ta = document.querySelector('#conversation .msg.editing .edit-ta'), text = ta ? ta.value.trim() : '', ev = editing && (evs || []).find(e => (e.type === 'prompt' || e.type === 'command') && e.ts === editing.ts);
        editing = null;
        if (ev && text && text !== String(ev.text).trim()) editResend(ev, text); else rerender();
      }
      else if (act.dataset.act === 'ver') {
        const ev = (evs || [])[+act.closest('[data-i]').dataset.i]; if (!ev || !ev.alts) return;
        const n = ev.alts.length, k = Math.max(0, Math.min(n, (ev._ver != null ? ev._ver : n) + +act.dataset.d));
        if (k === n) verView.delete(selectedId); else verView.set(selectedId, { ts: ev._ts || ev.ts, k });
        rerender();
      }
      else if (act.dataset.act === 'ask-submit') { // the CLI's Submit row sits under the boxes: go there, Enter
        const s = screenAsk(selectedId), last = s.options.map(o => isBox(o.label)).lastIndexOf(true);
        const onSubmit = (screenOf(selectedId, 30) || []).some(r => /^\s*[❯›]\s*Submit\s*$/.test(r));
        const d = onSubmit ? 0 : last + 1 - askFocus(s); if (last < 0) return;
        keys(arrowKeys(d).concat(['\r'])); askAhead = null; setTimeout(rerender, Math.abs(d) * 70 + 400);
      }
      else if (act.dataset.act === 'answer') { if (screenAsk(selectedId).options.length) document.getElementById('term-order-input').focus(); else switchTermTab('terminal'); } // your own words, from the reply box
      else if (act.dataset.act === 'undo-turn') undoTurn(evs || [], +act.dataset.from, +act.dataset.to, a);
      else if (act.dataset.act === 'turn-edits') openChanges(evs || [], +act.dataset.from, +act.dataset.to, a);
      else if (act.dataset.act === 'turn-edits-inline') showEditsInline(evs || [], +act.dataset.from, +act.dataset.to);
      else if (act.dataset.act === 'mode') openModeMenu(act, act.dataset.modeCur);
      else if (act.dataset.act === 'model') openModelMenu(act);
      else if (act.dataset.act === 'session-changes') openSessionChanges();
      else if (act.dataset.act === 'view-menu') openViewMenu(act);
      else if (act.dataset.act === 'expand-earlier') { expanded.add(selectedId); rerender(); }
      else if (act.dataset.act === 'mark') toggleMark(act.dataset.ts);
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
    const ref = e.target.closest('a.fileref'); // file:line → the file at that line in the editor
    if (ref && ref.classList.contains('img')) { e.preventDefault(); lightbox(fileUrl(ref.dataset.file)); return; }
    if (ref) { e.preventDefault(); peekEl.hidden = true; api.send({ type: 'openFileAt', cwd, file: ref.dataset.file, line: ref.dataset.line }); return; }
    const link = e.target.closest('a[href]'); if (!link) return;
    e.preventDefault();
    const c = classifyHref(link.dataset.href || link.getAttribute('href'), (cwd || '').replace(/\\/g, '/') + '/_');
    if (c.kind === 'external') api.send({ type: 'openUrl', url: c.url });
    else if (c.kind === 'doc') api.send({ type: 'docOpen', paths: [c.path] });
    else if (c.kind === 'file') api.send({ type: 'docOpenWith', path: c.path });
  }

  // An image full size over the app; a click or Esc closes it.
  function lightbox(src) {
    const d = document.createElement('div'); d.className = 'chat-lightbox'; d.setAttribute('role', 'dialog'); d.setAttribute('aria-modal', 'true'); d.setAttribute('aria-label', 'Image'); d.innerHTML = `<img src="${escH(src)}" alt="">`;
    const close = () => { d.remove(); document.removeEventListener('keydown', key, true); };
    const key = (e) => { if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); close(); } };
    d.onclick = close; document.addEventListener('keydown', key, true); document.body.appendChild(d);
  }
  document.getElementById('chat-att').addEventListener('click', (e) => { const i = e.target.closest('img'); if (i) lightbox(i.src); });

  // Resting on an image (thumbnail, [Image #N] chip, image path chip, a box attachment) shows it big above it, like
  // the terminal's image tags; a click still opens it full size.
  const imgPeek = document.createElement('img'); imgPeek.id = 'chat-imgpeek'; imgPeek.alt = ''; imgPeek.hidden = true; document.body.appendChild(imgPeek);
  let imgFor = null, imgTimer = null;
  const IMG_SEL = '#conversation .imgtag[data-src], #conversation .imgs img, #conversation a.fileref.img, #chat-att img';
  const imgSrc = (el) => el.matches('.imgtag') ? el.dataset.src : el.matches('a.fileref') ? fileUrl(el.dataset.file) : el.src;
  const hideImg = () => { imgFor = null; clearTimeout(imgTimer); imgPeek.hidden = true; };
  document.addEventListener('mouseover', (e) => {
    const el = e.target.closest && e.target.closest(IMG_SEL);
    if (!el) { if (imgFor) hideImg(); return; }
    if (el === imgFor || document.querySelector('.chat-lightbox')) return;
    hideImg(); imgFor = el;
    imgTimer = setTimeout(() => {
      const show = () => {
        if (imgFor !== el) return;
        imgPeek.hidden = false;
        const b = el.getBoundingClientRect(), w = imgPeek.offsetWidth, h = imgPeek.offsetHeight;
        imgPeek.style.left = Math.max(8, Math.min(b.left, innerWidth - w - 8)) + 'px';
        imgPeek.style.top = (b.top - h - 8 > 8 ? b.top - h - 8 : Math.min(b.bottom + 8, innerHeight - h - 8)) + 'px';
      };
      const src = imgSrc(el);
      if (imgPeek.getAttribute('src') !== src) { imgPeek.onload = show; imgPeek.src = src; } else show();
    }, 250);
  });
  document.addEventListener('mousedown', hideImg, true);
  document.addEventListener('wheel', hideImg, { capture: true, passive: true });

  // Opening a run of calls that had a failure opens the failed call too: "1 failed" should show which.
  document.getElementById('conversation').addEventListener('toggle', (e) => { const d = e.target; if (d.matches && d.matches('details.tgroup') && d.open) { const f = d.querySelector('details.trow.err'); if (f) f.open = true; } }, true);

  // ── A turn's changes at a glance: the files it touched on the left (+/−), the picked file's diff on the right,
  // every edit to that file stacked in order. ↑/↓ (or j/k) move between files, Esc closes, Open opens the file. ──
  function openChanges(evs, from, to, a) {
    const doneBy = new Map(); for (const e of evs) if (e.type === 'tool_done') doneBy.set(e.toolId, e);
    const files = new Map(); // path → { path, add, del, created, sections: [{ label, rows }] }
    for (let i = Math.max(0, from); i <= to && i < evs.length; i++) {
      const e = evs[i], d = e.type === 'tool' && doneBy.get(e.toolId);
      if (!d || d.err || !e.args || (e.args.old == null && e.args.new == null)) continue;
      const p = e.args.file_path || e.args.notebook_path || '?', s = editStat(e);
      if (!files.has(p)) files.set(p, { path: p, add: 0, del: 0, created: e.name === 'Write', sections: [] });
      const f = files.get(p); f.add += s.add; f.del += s.del; f.sections.push({ rows: s.rows });
    }
    for (const f of files.values()) if (f.sections.length > 1) f.sections.forEach((x, j) => { x.label = `Edit ${j + 1} of ${f.sections.length}`; });
    showChanges('This turn', [...files.values()], a, `<button type="button" class="cc-inline" data-inline="1">Show in chat</button>`, () => showEditsInline(evs, from, to));
  }
  // Everything uncommitted in the agent's folder (git diff HEAD + new files), in the same panel.
  function openSessionChanges() {
    const a = agents.get(selectedId); if (!a) return;
    showChanges('Uncommitted', null, a); api.send({ type: 'gitDiff', id: selectedId, cwd: a.cwd });
  }
  function onGitDiff(msg) {
    const p = document.getElementById('chat-changes'); if (!p || p.dataset.kind !== 'Uncommitted' || msg.id !== selectedId) return;
    const files = parseUnified(msg.diff).map(f => ({ path: (msg.cwd || '').replace(/\\/g, '/') + '/' + f.file, rel: f.file, tracked: !f.created, add: f.add, del: f.del, created: f.created, deleted: f.deleted, sections: [{ rows: f.rows }] }));
    for (const u of msg.untracked || []) { const rows = u.text.split('\n').map(s => ({ t: '+', s })); files.push({ path: (msg.cwd || '').replace(/\\/g, '/') + '/' + u.file, rel: u.file, tracked: false, add: rows.length, del: 0, created: true, sections: [{ rows }] }); }
    showChanges('Uncommitted', files, agents.get(selectedId), '', null, msg.error && !files.length ? `git: ${msg.error}` : 'Nothing uncommitted');
  }
  // The panel: files on the left (+/−), the picked file's diff on the right. ↑/↓ or j/k move, Esc closes. Per file:
  // Open (at its first change), Copy diff, Whole file (the file as it is now, changed lines marked).
  function showChanges(kind, list, a, extra = '', onInline = null, empty = '') {
    closeChanges(true);
    const cwd = String((a && a.cwd) || '').replace(/\\/g, '/').toLowerCase();
    const rel = (p) => { const q = String(p).replace(/\\/g, '/'); return cwd && q.toLowerCase().startsWith(cwd + '/') ? q.slice(cwd.length + 1) : q; };
    const panel = document.createElement('div'); panel.id = 'chat-changes'; panel.tabIndex = -1; panel.dataset.kind = kind;
    panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-modal', 'true'); panel.setAttribute('aria-label', kind === 'This turn' ? 'Changes in this turn' : 'Uncommitted changes');
    returnTo = document.activeElement; trapFocus(panel);
    const tot = (list || []).reduce((t, f) => ({ add: t.add + f.add, del: t.del + f.del }), { add: 0, del: 0 });
    const head = `<div class="cc-h">${ICON.edit}<b>${escH(kind === 'This turn' ? 'Changes' : 'Uncommitted changes')}</b>${list ? `<span class="cc-tot">${list.length} file${list.length === 1 ? '' : 's'} <b class="add">+${tot.add}</b> <b class="del">−${tot.del}</b></span>` : ''}<span class="grow"></span>${extra}<button type="button" class="cc-x" aria-label="Close">×</button></div>`;
    if (!list) panel.innerHTML = head + '<div class="cc-empty"><span class="loading"></span></div>';
    else if (!list.length) panel.innerHTML = head + `<div class="cc-empty">${escH(empty || 'No changes')}</div>`;
    else panel.innerHTML = head + `<div class="cc-body"><div class="cc-files">${list.map((f, k) => `<button type="button" class="cc-f" data-k="${k}" title="${escH(f.path)}"><span class="cc-n">${escH(baseName(f.path))}${f.created ? '<em>new</em>' : f.deleted ? '<em class="gone">deleted</em>' : ''}</span><span class="cc-d">${escH(rel(f.path).split('/').slice(0, -1).join('/'))}</span><span class="cc-s"><b class="add">+${f.add}</b> <b class="del">−${f.del}</b></span></button>`).join('')}</div><div class="cc-diff"></div></div>`;
    document.getElementById('term').appendChild(panel);
    let cur = 0, whole = false;
    const draw = () => {
      const f = list[cur];
      // The file name keeps the room: Whole file and Open as words, copy path / copy diff as icons, Revert quiet until hovered.
      const tools = `<button type="button" class="cc-btn${whole ? ' on' : ''}" data-whole="1" aria-pressed="${whole}">Whole file</button><button type="button" class="cc-btn" data-open="1">Open</button><button type="button" class="cc-btn ic-only" data-path="1" title="Copy path" aria-label="Copy path">${ICON.copy}</button><button type="button" class="cc-btn ic-only" data-copy="1" title="Copy diff" aria-label="Copy diff">${ICON.diff}</button>${f.rel ? `<button type="button" class="cc-btn ic-only danger" data-revert="1" title="${f.tracked ? 'Revert file' : 'Delete new file'}" aria-label="${f.tracked ? 'Revert file' : 'Delete new file'}">${f.tracked ? ICON.retry : ICON.trash}</button>` : ''}`;
      panel.querySelector('.cc-diff').innerHTML = `<div class="cc-dh"><span class="mono">${escH(rel(f.path))}</span>${tools}</div>` + (whole ? '<div class="cc-whole"><span class="loading"></span></div>'
        : f.sections.map(x => `${x.label ? `<div class="cc-sep">${escH(x.label)}</div>` : ''}${rowsHtml(x.rows, f.path)}`).join(''));
      if (whole) api.send({ type: 'filePeek', cwd: a && a.cwd, file: f.path, line: 0, all: true, seq: 'whole:' + cur });
      panel.querySelector('.cc-diff').scrollTop = 0;
    };
    const pick = (k) => {
      if (!list || !list.length) return;
      cur = (k + list.length) % list.length; whole = false;
      for (const b of panel.querySelectorAll('.cc-f')) b.classList.toggle('on', +b.dataset.k === cur);
      panel.querySelector('.cc-f.on')?.scrollIntoView({ block: 'nearest' });
      draw();
    };
    panel._whole = (msg) => { // the file as it is now, the lines this change added marked
      if (!whole || msg.seq !== 'whole:' + cur) return;
      const f = list[cur], added = new Set(f.sections.flatMap(x => x.rows.filter(r => r.t === '+').map(r => r.s)));
      const rows = (msg.lines || []).map(s => ({ t: added.has(s) ? '+' : ' ', s }));
      const box = panel.querySelector('.cc-whole'); if (box) box.outerHTML = rows.length ? rowsHtml(rows, f.path).replace('class="diff"', 'class="diff whole"') : `<div class="cc-empty">The file isn't there any more</div>`;
    };
    panel.addEventListener('click', (e) => {
      const b = e.target.closest('.cc-f'); if (b) return pick(+b.dataset.k);
      if (e.target.closest('.cc-x')) return closeChanges();
      if (e.target.closest('[data-inline]') && onInline) { closeChanges(); return onInline(); }
      const f = list && list[cur]; if (!f) return;
      if (e.target.closest('[data-open]')) { const first = f.sections[0] && f.sections[0].rows.find(r => r.t === '+'); return api.send({ type: 'openFileAt', cwd: a && a.cwd, file: f.path, line: 1 }); }
      if (e.target.closest('[data-whole]')) { whole = !whole; return draw(); }
      const cp = e.target.closest('[data-path]'); if (cp) { navigator.clipboard.writeText(f.path).then(() => { cp.classList.add('done'); setTimeout(() => cp.classList.remove('done'), 1200); }); return; }
      // Revert: back to the last commit, after a confirm (it can't be undone from here). The panel then reloads.
      if (e.target.closest('[data-revert]') && f.rel) {
        const q = f.tracked ? `Revert ${f.rel} to the last commit? This throws away its uncommitted changes.` : `Delete ${f.rel}? It's a new file, so this removes it.`;
        showConfirm(q, f.tracked ? 'Revert' : 'Delete').then(ok => { if (ok) api.send({ type: 'gitRevertFile', id: selectedId, cwd: a && a.cwd, file: f.rel, untracked: !f.tracked }); });
        return;
      }
      const c = e.target.closest('[data-copy]');
      if (c) { navigator.clipboard.writeText(f.sections.map(x => x.rows.map(r => (r.t === '…' ? '@@' : r.t) + r.s).join('\n')).join('\n@@\n')).then(() => { c.classList.add('done'); setTimeout(() => c.classList.remove('done'), 1200); }); }
    });
    panel.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeChanges(); }
      else if (e.key === 'ArrowDown' || e.key === 'j') { e.preventDefault(); pick(cur + 1); }
      else if (e.key === 'ArrowUp' || e.key === 'k') { e.preventDefault(); pick(cur - 1); }
    });
    pick(0); panel.focus();
  }
  function closeChanges(keepFocus) { const p = document.getElementById('chat-changes'); if (p) { p.remove(); if (!keepFocus) backFocus(); } }
  // Panels are dialogs: Tab stays inside, and closing puts focus back where it was (the chip or link that opened it).
  let returnTo = null;
  const backFocus = () => { const r = returnTo; returnTo = null; (r && document.contains(r) ? r : document.getElementById('term-order-input'))?.focus(); };
  function trapFocus(box) {
    box.addEventListener('keydown', (e) => {
      if (e.key !== 'Tab') return;
      const f = [...box.querySelectorAll('button, [href], input, [tabindex]:not([tabindex="-1"])')].filter(x => !x.disabled && x.offsetParent);
      if (!f.length) return;
      const first = f[0], last = f[f.length - 1];
      if (e.shiftKey && (document.activeElement === first || document.activeElement === box)) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    });
  }
  // The old way, still one click away: open that turn's edit rows in the thread and scroll to the first.
  function showEditsInline(evs, from, to) {
    let first = null;
    for (const d of document.querySelectorAll('#conversation details.trow.k-edit')) {
      const i = evs.findIndex(x => x.toolId === d.dataset.tid); if (i < from || i > to) continue;
      const g = d.parentElement.closest('details'); if (g) g.open = true; d.open = true; first = first || d;
    }
    if (first) first.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }

  // ── Another agent needs you: a toast you can answer from (Allow / Always / Deny, or the question's options read off
  // that agent's terminal), so there's no switching for a quick yes. Gone once it's answered (permClear). A button
  // only acts while that agent's prompt is still open, so a stale toast can never type into it. At most 3 show; the
  // rest wait in the ⋯ menu's Needs you list. They sit over the chat pane's top-right corner, not the whole window. ──
  const toasts = document.createElement('div'); toasts.id = 'chat-toasts'; toasts.setAttribute('role', 'region'); toasts.setAttribute('aria-label', 'Agents that need you');
  document.body.appendChild(toasts);
  const stillWaiting = (id) => { const a = agents.get(id); return !!(a && [...a.tools.values()].some(t => t.perm && !t.done)); };
  function placeToasts() {
    // In the agent list on the left, just above its footer (PRs, releases, usage), as wide as the list: never over the
    // chat. With the list hidden (world view without a roster), the window's top-right.
    const col = document.getElementById('list-col'), cr = col && col.offsetWidth ? col.getBoundingClientRect() : null;
    const foot = document.getElementById('list-foot'), fr = foot && foot.offsetHeight ? foot.getBoundingClientRect() : null;
    document.getElementById('conversation')?.style.setProperty('--toast-h', '0px');
    if (cr && cr.width > 160) {
      toasts.style.left = (cr.left + 10) + 'px'; toasts.style.right = 'auto'; toasts.style.width = (cr.width - 20) + 'px';
      toasts.style.top = 'auto'; toasts.style.bottom = (innerHeight - (fr ? fr.top : cr.bottom) + 10) + 'px';
    } else { toasts.style.left = 'auto'; toasts.style.width = ''; toasts.style.right = '16px'; toasts.style.bottom = 'auto'; toasts.style.top = '56px'; }
    const shown = [...toasts.querySelectorAll('.ctoast')];
    shown.forEach((el, k) => { el.hidden = k >= 3; });
    let more = toasts.querySelector('.ct-more');
    if (shown.length > 3) { if (!more) { more = document.createElement('button'); more.type = 'button'; more.className = 'ct-more'; more.onclick = () => { const v = document.querySelector('#chat-chips [data-act="view-menu"]'); if (v) openViewMenu(v); }; toasts.appendChild(more); } more.textContent = `+${shown.length - 3} more waiting`; }
    else if (more) more.remove();
  }
  function permToast(id, ask) {
    const a = agents.get(id); if (!a || worldView || id === selectedId || !stillWaiting(id)) return; // the one on screen shows its own card
    dropToast(id);
    const tools = [...a.tools.values()], t = tools.find(x => ask ? x.perm === 'ask' : x.perm === true) || tools.find(x => x.perm) || {}, opts = ask ? quickOpts(id) : [];
    const el = document.createElement('div'); el.className = 'ctoast'; el.dataset.id = id; el.setAttribute('role', 'alert');
    el.innerHTML = `<div class="ct-h">${ask ? ICON.ask : ICON.shield}<b>${escH(a.title || 'Agent')}</b><span>${ask ? 'has a question' : 'wants to run'}</span><button type="button" class="ct-x" aria-label="Dismiss">×</button></div>`
      + (() => { const w = ask ? screenAsk(id).question : (t.status || t.name || ''); return w && !/^Waiting for your (answer|permission)$/i.test(w) ? `<div class="ct-what${ask ? ' q' : ''}">${escH(w)}</div>` : ''; })()
      + `<div class="ct-btns">${ask ? opts.slice(0, 4).map((o, k) => `<button type="button" data-pick="${k}">${escH(o)}</button>`).join('') : permBtns(id, 'data-k')}<button type="button" data-open="1">Open</button></div>`;
    el.addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b) return;
      if (b.classList.contains('ct-x')) { el.remove(); return placeToasts(); }
      if (b.dataset.open) { el.remove(); placeToasts(); focusAgent(id); return; }
      if (!stillWaiting(id)) { el.remove(); placeToasts(); return; } // answered elsewhere already: never type into a live prompt
      if (b.dataset.k) { if (!menuUp(id)) { el.remove(); placeToasts(); return; } api.send({ type: 'termInput', id, data: b.dataset.k === 'esc' ? '\x1b' : b.dataset.k }); }
      if (b.dataset.pick && !pickOption(id, +b.dataset.pick)) { el.remove(); placeToasts(); return; }
      if (b.dataset.pick) announce(`Answered ${a.title || 'the agent'}`);
      const said = b.dataset.k === 'esc' ? 'Denied' : b.dataset.k ? 'Allowed' : 'Answered: ' + b.textContent;
      el.querySelector('.ct-btns').innerHTML = `<span class="ct-ok">${escH(said)}</span>`;
      setTimeout(() => el.classList.add('done'), 800); setTimeout(() => { el.remove(); placeToasts(); }, 1100);
    });
    toasts.prepend(el); placeToasts();
  }
  addEventListener('resize', placeToasts);
  { const col = document.getElementById('list-col'); if (col) new ResizeObserver(() => { if (toasts.childElementCount) placeToasts(); }).observe(col); } // the list resized or hidden: follow it
  // An agent that finished while you were elsewhere: a short note in the same stack (left, in the agent list), its last
  // line under its name; a click opens it, and it goes by itself after a few seconds.
  function doneToast(id, line) {
    const a = agents.get(id); if (!a) return;
    for (const t of toasts.querySelectorAll(`.ctoast.fin[data-id="${id}"]`)) t.remove();
    const el = document.createElement('div'); el.className = 'ctoast fin'; el.dataset.id = id; el.setAttribute('role', 'status');
    el.innerHTML = `<div class="ct-h">${ICON.check}<b>${escH(a.title || 'Agent')}</b><span>finished</span><button type="button" class="ct-x" aria-label="Dismiss">×</button></div>${line ? `<div class="ct-what q">${escH(line)}</div>` : ''}`;
    el.addEventListener('click', (e) => { el.remove(); placeToasts(); if (!e.target.closest('.ct-x')) focusAgent(id); });
    toasts.prepend(el); placeToasts();
    setTimeout(() => { if (el.isConnected) { el.classList.add('done'); setTimeout(() => { el.remove(); placeToasts(); }, 300); } }, 6000);
  }
  // Only an agent that has really finished gets the note: still idle 10 s after its turn ended (status flickers between
  // steps don't count) and not reporting that it's still at work ("I AM WORKING", e.g. waiting on a run it started).
  const doneTimers = new Map();
  function maybeDone(id) {
    clearTimeout(doneTimers.get(id));
    doneTimers.set(id, setTimeout(() => {
      doneTimers.delete(id);
      const a = agents.get(id); if (!a || a.status !== 'waiting' || id === selectedId) return;
      const p = String(a.preview || '');
      if (/\bI AM WORKING\b/i.test(p)) return;
      doneToast(id, p.split(/\r?\n/).map(l => l.trim()).filter(Boolean).find(l => !/^I AM (DONE|WORKING)|^I NEED YOU/i.test(l)) || '');
    }, 10000));
  }
  function dropToast(id) { for (const t of toasts.querySelectorAll(`.ctoast[data-id="${id}"]`)) t.remove(); placeToasts(); }

  // ── Needs you: every agent waiting on you (a question, a permission) or finished unseen. Listed in the ⋯ menu; the
  // ⋯ chip carries a count while any of them is urgent. ──
  function inboxItems() {
    const items = [];
    for (const [id, a] of agents) {
      if (a.archived) continue;
      const st = agentStatus(a), perm = [...a.tools.values()].find(t => t.perm);
      if (perm) items.push({ id, a, kind: perm.perm === 'ask' ? 'question' : 'permission', what: perm.status || perm.name || '' });
      else if (a.unread) items.push({ id, a, kind: 'done', what: a.preview || '' });
      else if (st === 'crashed') items.push({ id, a, kind: 'crashed', what: 'Stopped' });
    }
    // Oldest first: when each one started waiting is noted the first time it shows up here.
    const now = Date.now(), seen = new Set(items.map(x => x.id + x.kind));
    for (const x of items) { const k = x.id + x.kind; if (!waitSince.has(k)) waitSince.set(k, now); x.since = waitSince.get(k); }
    for (const k of [...waitSince.keys()]) if (!seen.has(k)) waitSince.delete(k);
    return items.sort((p, q) => (p.kind === 'done') - (q.kind === 'done') || p.since - q.since);
  }
  const waitSince = new Map(); // agent id + kind → when it started waiting
  function syncInbox() {
    const chip = document.querySelector('#chat-chips [data-act="view-menu"]'); if (!chip) return;
    const n = inboxItems().filter(x => x.id !== selectedId && x.kind !== 'done').length;
    chip.dataset.count = n ? String(n) : ''; chip.classList.toggle('alert', n > 0);
    chip.setAttribute('aria-label', n ? `${n} agent${n > 1 ? 's' : ''} need you · view options` : 'View options');
  }

  // ── file:line links: click opens the file at the line in your editor; resting on one peeks at those lines ──
  let peekSeq = 0, peekFor = null, peekTimer = null;
  const peekEl = document.createElement('div'); peekEl.id = 'chat-peek'; peekEl.hidden = true; document.body.appendChild(peekEl);
  const conv = document.getElementById('conversation');
  // Opening a collapsed row (a summary click) whose contents run past the bottom scrolls it up to the top of the view,
  // so what opened is in sight; checked again a moment later for content that loads in (a subagent's steps).
  conv.addEventListener('click', (e) => {
    const s = e.target.closest('summary'); if (!s) return;
    const d = s.parentElement;
    const fit = () => {
      if (!d.open || !d.isConnected) return;
      const v = conv.getBoundingClientRect(), r = d.getBoundingClientRect();
      if (r.bottom > v.bottom - 8 && r.top > v.top + 8) conv.scrollBy({ top: r.top - v.top - 8, behavior: 'smooth' });
    };
    requestAnimationFrame(fit); setTimeout(fit, 450);
  });
  conv.addEventListener('mouseover', (e) => {
    const r = e.target.closest('a.fileref'); if (!r || r === peekFor || r.classList.contains('img')) return; // an image has no lines to peek
    peekFor = r; clearTimeout(peekTimer);
    peekTimer = setTimeout(() => { const a = agents.get(selectedId); api.send({ type: 'filePeek', cwd: a && a.cwd, file: r.dataset.file, line: r.dataset.line, seq: ++peekSeq }); }, 350);
  });
  // Keyboard: tabbing onto a link peeks the same way (Enter opens it).
  conv.addEventListener('focusin', (e) => { const r = e.target.closest && e.target.closest('a.fileref'); if (r) r.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); });
  conv.addEventListener('focusout', (e) => { const r = e.target.closest && e.target.closest('a.fileref'); if (r) { peekFor = null; clearTimeout(peekTimer); peekEl.hidden = true; } });
  conv.addEventListener('mouseout', (e) => { const r = e.target.closest('a.fileref'); if (r && !r.contains(e.relatedTarget)) { peekFor = null; clearTimeout(peekTimer); peekEl.hidden = true; } });
  function showPeek(msg) {
    if (msg.seq !== peekSeq || !peekFor || !msg.lines || !msg.lines.length) return;
    const rows = msg.lines.map((s, k) => ({ n: msg.start + k, s }));
    const ext = String(msg.path).split('.').pop().toLowerCase(), lang = LANG[ext], hl = lang && window.hljs && hljs.getLanguage(lang);
    const fmt = (s) => { if (hl) try { return hljs.highlight(s || ' ', { language: lang, ignoreIllegals: true }).value; } catch {} return escH(s) || ' '; };
    peekEl.innerHTML = `<div class="pk-h">${escH(String(msg.path).replace(/\\/g, '/').split('/').slice(-2).join('/'))}<span>:${msg.line}</span></div><div class="pk-b">${rows.map(r => `<div class="pk-l${r.n === msg.line ? ' on' : ''}"><i>${r.n}</i><span>${fmt(r.s)}</span></div>`).join('')}</div>`;
    const b = peekFor.getBoundingClientRect(); peekEl.hidden = false;
    const h = peekEl.getBoundingClientRect();
    peekEl.style.left = Math.max(8, Math.min(b.left, innerWidth - h.width - 8)) + 'px';
    peekEl.style.top = (b.top - h.height - 8 > 8 ? b.top - h.height - 8 : b.bottom + 8) + 'px';
  }

  // One panel at a time over the view (a shell's output, a pasted text, an agent's steps): a dialog that keeps focus
  // inside it and closes on Esc, a click outside, or its ×.
  function newPanel(label) {
    const d = document.createElement('div'); d.id = 'chat-shell'; d.setAttribute('role', 'dialog'); d.setAttribute('aria-label', label); d.tabIndex = -1; returnTo = document.activeElement; trapFocus(d);
    d.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeShell(); } });
    return d;
  }
  // ── A background shell's live output: a panel over the view, re-read every 2 s while it's open ──
  let shellTimer = null;
  function openShell(file, name) {
    closeShell();
    const d = newPanel('Background shell output');
    d.innerHTML = `<div class="sh-h">${ICON.cmd}<span>${escH(name)}</span><button type="button" class="sh-x" aria-label="Close">×</button></div><pre class="sh-out">…</pre>`;
    d.querySelector('.sh-x').onclick = closeShell; d.dataset.file = file;
    document.getElementById('term').appendChild(d);
    const pull = () => api.send({ type: 'bgTail', id: selectedId, file });
    pull(); shellTimer = setInterval(pull, 2000); d.focus();
  }
  // Any text in the same panel (a pasted text's full content).
  function openText(name, text) {
    closeShell();
    const d = newPanel(name);
    d.innerHTML = `<div class="sh-h">¶<span>${escH(name)}</span><button type="button" class="sh-x" aria-label="Close">×</button></div><pre class="sh-out"></pre>`;
    d.querySelector('.sh-out').textContent = text; d.querySelector('.sh-x').onclick = closeShell;
    document.getElementById('term').appendChild(d); d.focus();
  }
  function closeShell() { clearInterval(shellTimer); shellTimer = null; const d = document.getElementById('chat-shell'); if (d) { d.remove(); backFocus(); } }

  // ── A subagent's steps in a panel over the view (like a background shell's output), re-read every 2 s while it runs ──
  function openAgent(tid, evs) {
    const call = evs.find(x => x.type === 'tool' && x.toolId === tid); if (!call) return;
    closeShell();
    const done = evs.find(x => x.type === 'tool_done' && x.toolId === tid), a = call.args || {}, name = a.description || a.subagent_type || 'Agent';
    const d = newPanel(name); d.className = 'agentp'; d.dataset.tid = tid;
    // A background agent's call returns at once with the CLI's launch note (for the model, not you): it's still running.
    const bgRun = !!(done && done.agentId && /^Async agent launched/i.test(done.text || '') && !evs.some(x => x.type === 'bgdone' && x.taskId === done.agentId));
    const running = !done || bgRun, out = done && done.text && !/^Async agent launched/i.test(done.text) ? done.text.replace(/\s+$/, '') : '';
    d.innerHTML = `<div class="sh-h">${ICON.agent}<span>${escH(name)}</span>${running ? '<span class="dot"></span>' : ''}<button type="button" class="sh-x" aria-label="Close">×</button></div>`
      + `<div class="ap-b">${a.prompt ? `<details class="ap-task"><summary>Task</summary><div class="md sub">${md(a.prompt, '')}</div></details>` : ''}<div class="agent-steps"><div class="as-h">Loading…</div></div>${out ? `<div class="ap-res"><div class="as-h">Result</div><div class="md sub">${md(out, '')}</div></div>` : ''}</div>`;
    d.querySelector('.sh-x').onclick = closeShell;
    d.addEventListener('click', (e) => { const r = e.target.closest('[data-agent-tid]'); if (r) e.stopPropagation(); }); // a nested agent's row stays put
    document.getElementById('term').appendChild(d);
    const pull = () => api.send({ type: 'agentSteps', id: selectedId, toolId: tid, agentId: done && done.agentId });
    pull(); if (running) shellTimer = setInterval(pull, 2000); d.focus();
  }
  // Any panel (shell output, an agent, a pasted text) closes on a click outside it, like a popover.
  document.addEventListener('mousedown', (e) => {
    const p = document.getElementById('chat-shell'); if (!p || p.contains(e.target)) return;
    if (e.target.closest('#chat-bg, #chat-hover, [data-agent-tid], [data-jump], [data-bgout], [data-pn]')) return; // what opens one swaps it instead
    closeShell();
  });
  document.getElementById('conversation').addEventListener('keydown', (e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target.matches && e.target.matches('[data-agent-tid]')) { e.preventDefault(); e.target.click(); } });
  function drawSteps(evs) {
    const box = document.querySelector('#chat-shell.agentp .agent-steps'); if (!box) return;
    const doneBy = new Map(); for (const ev of evs) if (ev.type === 'tool_done') doneBy.set(ev.toolId, ev);
    const tools = evs.filter(ev => ev.type === 'tool'), atEnd = box.parentElement.scrollHeight - box.parentElement.scrollTop - box.parentElement.clientHeight < 40;
    const open = new Set([...box.querySelectorAll('details[open]')].map(x => x.dataset.tid)); // a re-read keeps what you opened
    box.innerHTML = tools.length ? `<div class="as-h">${tools.length} step${tools.length > 1 ? 's' : ''}</div>` + '<div class="tools">' + tools.map(ev => toolRow(ev, doneBy.get(ev.toolId), '')).join('') + '</div>' : '<div class="as-h">No steps yet</div>';
    for (const x of box.querySelectorAll('details[data-tid]')) if (open.has(x.dataset.tid)) x.open = true;
    if (atEnd) box.parentElement.scrollTop = box.parentElement.scrollHeight; // following a running agent
  }
  let undoRevert = null; // the latest Revert's undo, for Ctrl+Z while its toast shows
  document.addEventListener('keydown', (e) => { if (undoRevert && (e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'z' && !/^(INPUT|TEXTAREA)$/.test(document.activeElement && document.activeElement.tagName)) { e.preventDefault(); undoRevert(); } }, true);
  function onMsg(msg) {
    if (msg.type === 'gitDiff') return onGitDiff(msg);
    // Reverted: 10 seconds to take it back (git restore can't be undone, so main kept the file as it was).
    if (msg.type === 'gitReverted') {
      if (typeof msg.content !== 'string') return;
      // Click the toast or press Ctrl+Z within 10 s; main refuses if the file changed since the revert.
      const undo = () => { undoRevert = null; api.send({ type: 'restoreFileContent', id: msg.id, cwd: msg.cwd, file: msg.file, content: msg.content, after: msg.after }); };
      undoRevert = undo; showToast(`${msg.deleted ? 'Deleted' : 'Reverted'} ${msg.file} · click or Ctrl+Z to undo`, undo); announce(`${msg.deleted ? 'Deleted' : 'Reverted'} ${msg.file}. Ctrl+Z undoes it.`);
      setTimeout(() => { if (undoRevert === undo) undoRevert = null; const t = document.getElementById('toast'); if (t && /^(Reverted|Deleted) /.test(t.textContent)) t.className = 'toast'; }, 10000);
      return;
    }
    if (msg.type === 'filePeek' && String(msg.seq).startsWith('plan:')) { const t = (msg.lines || []).join('\n').trim(); planTexts.set(String(msg.seq).slice(5), t || null); if (t) rerender(); return; } // null: unreadable, asked once
    if (msg.type === 'filePeek') { if (String(msg.seq).startsWith('whole:')) { const p = document.getElementById('chat-changes'); if (p && p._whole) p._whole(msg); } else showPeek(msg); return; }
    if (msg.type === 'agentSteps' || msg.type === 'bgTail') hoverLive(msg);
    if (msg.type === 'agentSteps') { const p = document.getElementById('chat-shell'); if (p && p.dataset.tid === msg.toolId) drawSteps(msg.events || []); }
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
    bar.hidden = false; document.getElementById('conversation').classList.add('finding'); // room above the thread so the bar never covers a match
    const inp = bar.querySelector('input'); inp.focus(); inp.select(); if (inp.value) runFind(inp.value);
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
  function closeFind() { const bar = document.getElementById('chat-find'); if (bar) bar.hidden = true; document.getElementById('conversation').classList.remove('finding'); if (window.CSS && CSS.highlights) { CSS.highlights.delete('chat-find'); CSS.highlights.delete('chat-find-cur'); } find = null; document.getElementById('term-order-input').focus(); }

  // Ctrl+↑/↓: the previous / next of your prompts, like the terminal's prompt jump.
  function jumpPrompt(dir) {
    const el = document.getElementById('conversation'), us = [...el.querySelectorAll('.thread > .msg.user[data-i], .thread > .msg.cmd[data-i]')]; if (!us.length) return;
    const top = el.getBoundingClientRect().top + 8, y = (u) => u.getBoundingClientRect().top;
    const target = dir < 0 ? [...us].reverse().find(u => y(u) < top - 4) : us.find(u => y(u) > top + 4);
    if (target) { target.scrollIntoView({ block: 'start', behavior: 'smooth' }); target.classList.remove('flash'); void target.offsetWidth; target.classList.add('flash'); }
  }

  // Another agent selected: what showed the old one's work follows the new one (Uncommitted changes reload for its
  // folder) or closes (a turn's changes, a shell's output, find, the chip menus).
  function onAgentSwitch() {
    const p = document.getElementById('chat-changes');
    if (p && p.dataset.kind === 'Uncommitted') openSessionChanges(); else if (p) closeChanges(true);
    closeShell(); closeModeMenu(); closeViewMenu(); document.getElementById('model-ctx-menu')?.remove();
    if (document.getElementById('chat-find') && !document.getElementById('chat-find').hidden) closeFind();
    peekEl.hidden = true;
  }

  // ── Side by side: terminal left, chat right (chat.css #term.split); remembered ──
  function toggleSplit(on) {
    const t = document.getElementById('term'); on = on ?? !t.classList.contains('split');
    t.classList.toggle('split', on); document.getElementById('hdr-split')?.classList.toggle('on', on);
    try { localStorage.setItem('chatSplit', on ? '1' : ''); } catch {}
    if (termTab === 'conversation') switchTermTab('conversation');
    if (typeof schedFit === 'function') setTimeout(schedFit, 50);
  }
  // ── A CLI dialog the chat has no card for (double-Esc rewind, /config, /model, /permissions, /mcp…): the real terminal
  // floats over the chat while it's up, keys going to it, and goes away when the dialog closes. ──
  let peekOff = 0, screenSig = '';
  const screenRows = (x, n) => bufferRows(x.terminal.buffer.active, n);
  let termPeekFor = null; // the agent whose terminal the overlay shows: switching agents shows the new one's, or none
  function peek(on) {
    const t = document.getElementById('term'), tc = document.getElementById('term-container'); if (!t || (t.classList.contains('peek') === on && (!on || termPeekFor === selectedId))) return;
    termPeekFor = on ? selectedId : null;
    t.classList.toggle('peek', on);
    if (on) { tc.style.display = ''; showXterm(selectedId); if (typeof schedFit === 'function') schedFit(); setTimeout(() => xterms.get(selectedId)?.terminal.focus(), 60); }
    else if (termTab === 'conversation') switchTermTab('conversation'); // back to the chat: terminal hidden, reply box focused
  }
  setInterval(() => {
    const t = document.getElementById('term'), cv = document.getElementById('conversation');
    const x = selectedId != null && typeof xterms !== 'undefined' && xterms.get(selectedId);
    // A card drawn from the screen (a question, the rewind list) follows it even while the agent is idle and nothing
    // else repaints: redraw whenever what it shows changed.
    if (x && termTab === 'conversation' && cv && cv.classList.contains('open')) {
      const sa = screenAsk(selectedId), rw = screenRewind(selectedId);
      const sig = JSON.stringify([sa.dialog, sa.question, sa.focus, sa.options.length, sa.preview, rw && rw.focus, rw && rw.items.length, liveMode(selectedId)]); // the mode chip follows Shift+Tab in the terminal too
      if (sig !== screenSig) { screenSig = sig; rerender(); }
    }
    const up = !!(x && termTab === 'conversation' && cv && cv.classList.contains('open') && !t.classList.contains('split') && !stillWaiting(selectedId) && screenDialog(screenRows(x, 40)) && screenAsk(selectedId).options.length < 2 && !screenRewind(selectedId)); // a question menu gets its card instead
    if (up) { peekOff = 0; peek(true); return; }
    if (t && t.classList.contains('peek') && termPeekFor === selectedId && ++peekOff < 2) return; // gone for two looks in a row: a redraw can blank it for a moment
    peek(false);
  }, 500);
  { const px = document.createElement('button'); px.id = 'term-peek-x'; px.type = 'button'; px.title = 'Close (Esc)'; px.setAttribute('aria-label', 'Close'); px.textContent = '×';
    px.onclick = () => api.send({ type: 'termInput', id: selectedId, data: '\x1b' }); document.getElementById('term')?.appendChild(px); } // Esc, as in the CLI: the dialog closes, then so does this

  try { if (localStorage.getItem('chatSplit') === '1') { document.getElementById('term').classList.add('split'); document.getElementById('hdr-split')?.classList.add('on'); } } catch {}

  window.chatUi = { onEscSent, dropPending: (id) => { const l = pending.get(id); if (l) l.pop(); }, doneToast, maybeDone, rewindStep, rewindPick: (k) => rewindPick(k), stop, askStep, askTab, askTo: (k) => askMove(k), askState: () => screenAsk(selectedId), linkLabel, onTask, onLinkTitle, linkWaiters, permToast, dropToast, syncInbox, toggleSplit, openFind, closeFind, jumpPrompt, onMsg, paint, onClick, syncJump, SPARK, keys, addPending: (id, text, imgs = [], held = false, match = '', pastes = [], restore = null) => { if (!pending.has(id)) pending.set(id, []); pending.get(id).push({ text, imgs, held, match, pastes, restore, at: Date.now() }); const ag = agents.get(id); if (ag) { ag._stopAt = 0; ag._reverted = 0; } jumpOnce = true; pinBottom(); }, releasePending: (id) => { const p = (pending.get(id) || []).find(x => x.held); if (p) { p.held = false; p.at = Date.now(); } }, onMdReady: (fn) => { rerender = fn; } };
})();
