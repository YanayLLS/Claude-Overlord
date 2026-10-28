// The Chat view's composer, doing what the CLI's prompt box does: Enter sends (the prompt shows at once, dimmed,
// until the transcript has it), Esc interrupts a working agent, ↑/↓ walk your earlier prompts, "/" or + opens the
// skills/commands picker, a pasted image goes to the agent's prompt as [Image #N] and shows here as a thumbnail.
(function () {
  const box = () => document.getElementById('term-order-input');
  let dict = null; // the mic's take in progress: { id, pre, post, said, live } (see Mic below)
  const order = () => document.getElementById('term-order');
  const chat = () => termTab === 'conversation';
  let hist = -1, draft = '';
  const grow = (t) => { t.style.height = 'auto'; t.style.height = t.scrollHeight + 'px'; order().classList.toggle('blank', !t.value.trim()); syncHl(); };

  // ── Images: each pasted or dropped image puts an [Image #N] tag at the caret and a numbered thumbnail above the box,
  // so a prompt can say "compare [Image #1] with [Image #2]". Nothing reaches the agent until Send: then the text and
  // the images go into its prompt in order (main's chatSend), each image where its tag stands. Deleting a tag (or ✕
  // on its thumbnail) drops that image. A screenshot is saved to a file by main first; Send waits for that.
  const atts = new Map(); // agent id → { list: [{ n, url, path, saving }], next }
  const attOf = (id) => { if (!atts.has(id)) atts.set(id, { list: [], next: 1 }); return atts.get(id); };
  const TAG = /\[Image #(\d+)\]/g;
  // A long paste (over 20 lines or 1,500 characters) becomes "[Pasted text #1 · 200 lines]" in the box, like the CLI,
  // with a chip above it to peek (hover), expand back into the box (click) or drop (✕); Send puts the text back in.
  const PASTE = /\[Pasted text #(\d+)[^\]]*\]/g;
  const FILE = /\[File #(\d+)[^\]]*\]/g; // a pasted or dropped file: a chip, its full path on send
  const escA = (s) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  function drawAtt() {
    syncDraft(); // called when the Chat view shows another agent: its own draft and images
    const a = atts.get(selectedId), list = a ? a.list : [], pastes = (a && a.pastes) || [], files = (a && a.files) || [];
    document.getElementById('chat-att').innerHTML = list.map(x => `<span class="att${x.saving ? ' saving' : ''}" data-n="${x.n}"><img src="${x.url}" alt=""><b>${x.n}</b><button type="button" class="att-x" title="Remove" aria-label="Remove image ${x.n}">×</button></span>`).join('')
      + pastes.map(x => `<span class="att doc" data-p="${x.n}" title="${escA(x.text.split('\n').slice(0, 8).join('\n'))}"><span class="doc-i">¶</span><span class="doc-t"><b>Pasted text #${x.n}</b><small>${x.lines} lines · click to expand</small></span><button type="button" class="att-x" title="Remove" aria-label="Remove pasted text ${x.n}">×</button></span>`).join('')
      + files.map(x => `<span class="att doc file" data-f="${x.n}" title="${escA(x.path)}"><span class="doc-i">${FILE_IC}</span><span class="doc-t"><b>${escA(x.name)}</b><small>#${x.n} · ${escA(x.dir || 'file')}</small></span><button type="button" class="att-x" title="Remove" aria-label="Remove ${escA(x.name)}">×</button></span>`).join('');
    order().classList.toggle('has-att', list.length + pastes.length + files.length > 0);
  }
  // A tag deleted from the text drops its image or pasted text (and its chip).
  function pruneAtt() {
    const a = atts.get(selectedId); if (!a || (!a.list.length && !(a.pastes || []).length && !(a.files || []).length)) return;
    const v = box().value, used = new Set([...v.matchAll(TAG)].map(m => +m[1])), usedP = new Set([...v.matchAll(PASTE)].map(m => +m[1])), usedF = new Set([...v.matchAll(FILE)].map(m => +m[1]));
    const keep = a.list.filter(x => used.has(x.n)), keepP = (a.pastes || []).filter(x => usedP.has(x.n)), keepF = (a.files || []).filter(x => usedF.has(x.n));
    if (keep.length !== a.list.length || keepP.length !== (a.pastes || []).length || keepF.length !== (a.files || []).length) { a.list = keep; a.pastes = keepP; a.files = keepF; if (!keep.length) a.next = 1; if (!keepP.length) a.nextP = 1; if (!keepF.length) a.nextF = 1; drawAtt(); }
  }
  function addPaste(text) {
    const a = attOf(selectedId); a.pastes = a.pastes || []; a.nextP = a.nextP || 1;
    const x = { n: a.nextP++, text, lines: text.split('\n').length }; a.pastes.push(x);
    insert(`[Pasted text #${x.n} · ${x.lines} lines] `); drawAtt();
  }
  // A file (not an image) by path: "[File #N]" in the text and a chip above, the quoted path when sent.
  const FILE_IC = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/></svg>';
  function addFileRef(path) {
    const r = pathRef(path); if (!r) return false;
    const a = attOf(selectedId); a.files = a.files || []; a.nextF = a.nextF || 1;
    if (r.img) { a.list.push({ n: a.next, url: fileUrlOf(r.file), path: r.file.replace(/\\/g, '/') }); insert(`[Image #${a.next++}] `); return true; } // an image path: a thumbnail like a pasted image
    const x = { n: a.nextF++, path: r.file, name: r.name, dir: r.dir }; a.files.push(x);
    insert(`[File #${x.n}] `); return true;
  }
  const fileUrlOf = (p) => 'file:///' + encodeURI(String(p).replace(/\\/g, '/').replace(/^\/+/, '')).replace(/#/g, '%23');
  const expandPastes = (text, a) => text.replace(PASTE, (m, n) => { const x = ((a && a.pastes) || []).find(p => p.n === +n); return x ? x.text : m; })
    .replace(FILE, (m, n) => { const x = ((a && a.files) || []).find(p => p.n === +n); return x ? (/\s/.test(x.path) ? `"${x.path}"` : x.path) : m; });
  let saveSeq = 0; const saving = new Map(); // seq → attachment waiting for main's saved path
  function addFiles(files) {
    const id = selectedId; if (id == null) return false;
    let took = false;
    for (const f of files) {
      const p = api.getFilePath(f) || '';
      if (f.type && f.type.startsWith('image/')) {
        const a = attOf(id), x = { n: a.next++, url: URL.createObjectURL(f), path: p.replace(/\\/g, '/'), saving: !p };
        a.list.push(x); took = true;
        if (!p) { const seq = ++saveSeq; saving.set(seq, x); api.send({ type: 'saveClipboardImage', id, seq }); } // a screenshot: main saves it
        insert(`[Image #${x.n}] `);
      } else if (p) { if (!addFileRef(p)) insert((/\s/.test(p) ? `"${p}"` : p) + ' '); took = true; } // any other file: a chip (a folder: its path, like the CLI)
    }
    drawAtt();
    return took;
  }
  function onImageSaved(msg) {
    const x = saving.get(msg.seq); if (!x) return;
    saving.delete(msg.seq); x.saving = false; x.path = msg.path || ''; drawAtt();
    for (const id of [...queued.keys()]) flush(id);
  }
  // The prompt as ordered parts: text, then each tagged image at its place. A tag whose image is gone stays as text.
  function parts(text, list) {
    const byN = new Map(list.map(x => [x.n, x])), out = []; let last = 0;
    for (const m of text.matchAll(TAG)) { const x = byN.get(+m[1]); if (!x || !x.path) continue; if (m.index > last) out.push({ text: text.slice(last, m.index) }); out.push({ image: x.path }); last = m.index + m[0].length; }
    if (last < text.length) out.push({ text: text.slice(last) });
    return out;
  }
  // A send made while a screenshot is still being saved waits for it (shown as "Attaching…").
  const queued = new Map(); // agent id → { text, list }
  function flush(id) {
    const q = queued.get(id); if (!q || q.list.some(x => x.saving)) return;
    queued.delete(id); deliver(id, q.text, q.list);
  }
  // Plain text goes as one paste (questPrompt); with images, main's chatSend lays text and images into the prompt in order.
  function deliver(id, text, list) {
    if (list.length) api.send({ type: 'chatSend', id, parts: parts(text, list) });
    else api.send({ type: 'questPrompt', id, text });
    chatUi.releasePending(id);
    if (chat()) renderConversation();
  }
  function send() {
    const inp = box(), id = selectedId; if (id == null) return;
    micStop();
    pruneAtt();
    const a = atts.get(id), shown = inp.value.trim(), text = expandLinks(expandPastes(inp.value, a), a).trim(), list = a ? a.list.splice(0) : [];
    const pastes = ((a && a.pastes) || []).slice(); // the sent bubble's paste chips open to their text
    if (a) { a.next = 1; a.pastes = []; a.nextP = 1; a.files = []; a.nextF = 1; a.links = []; }
    if (!text) { if (chat() && order().classList.contains('busy')) chatUi.keys(['\x1b']); return; } // empty + working: Stop
    if (chat() && /^\/resume$/.test(text) && !list.length) { inp.value = '/resume '; resumeCheck(inp); return; } // the CLI's picker is a full-screen dialog: list here
    const held = list.some(x => x.saving);
    if (chat()) chatUi.addPending(id, shown, list.map(x => x.url), held, text, pastes); // shows the box as typed (paste chips), matches the full text
    inp.value = ''; inp.style.height = ''; hist = -1; order().classList.add('blank'); drawAtt();
    if (held) { queued.set(id, { text, list }); if (chat()) renderConversation(); return; }
    deliver(id, text, list);
  }
  function insert(text, andSend) {
    const t = box(), s = t.selectionStart ?? t.value.length;
    t.value = t.value.slice(0, s) + text + t.value.slice(t.selectionEnd ?? s); t.focus();
    t.selectionStart = t.selectionEnd = s + text.length; grow(t);
    if (andSend) send();
  }
  const openPicker = () => catalogUi.open({ anchor: order(), insert, focus: () => box().focus() });

  function prompts() { const a = agents.get(selectedId); return ((a && a.prompts) || []).map(p => typeof p === 'string' ? p : (p && p.text) || '').filter(Boolean); }
  // ── @file suggestions: typing @name lists matching files in the agent's folder; ↑/↓ pick, Enter/Tab insert ──
  // …and "/name" anywhere at a word start lists matching commands and skills (the + picker's catalog), as the CLI does.
  let at = null, atSeq = 0; // { kind: '@' | '/', start, q, files, sel } while the list is open
  const atList = () => document.getElementById('chat-at');
  const catalog = new Map(); // cwd → catalog items (main's 'catalog' message, shared with the + picker)
  function atQuery(t) {
    const before = t.value.slice(0, t.selectionStart), m = /(^|\s)([@/])([^\s@/]*)$/.exec(before);
    return m ? { kind: m[2], start: t.selectionStart - m[3].length - 1, q: m[3] } : null;
  }
  function slashMatches(cwd, q) {
    const items = (catalog.get(cwd) || []).filter(i => i.insert && i.insert.startsWith('/')), lq = q.toLowerCase();
    const rank = (i) => { const n = i.name.toLowerCase(); return n.startsWith(lq) ? 0 : n.includes(lq) ? 1 : (i.desc || '').toLowerCase().includes(lq) ? 2 : -1; };
    return items.map(i => [rank(i), i]).filter(r => r[0] >= 0).sort((a, b) => a[0] - b[0] || a[1].name.length - b[1].name.length).slice(0, 12).map(r => r[1]);
  }
  // "/resume <filter>": the agent's other sessions, newest first; picking one runs "/resume <id>".
  const sessions = new Map(); // agent id → [{ id, title, mtime, size }]
  const resumeHits = (id, q) => (sessions.get(id) || []).filter(x => x.title.toLowerCase().includes(q.toLowerCase()));
  function resumeCheck(t) {
    const m = /^\/resume\s+(.*)$/s.exec(t.value);
    if (!m || !chat()) return false;
    if (!at || at.kind !== 'resume') api.send({ type: 'chatSessions', id: selectedId });
    at = { kind: 'resume', start: 0, q: m[1].trim(), files: resumeHits(selectedId, m[1].trim()), sel: 0 }; drawAt();
    return true;
  }
  function onSessions(msg) {
    sessions.set(msg.id, msg.sessions || []);
    if (at && at.kind === 'resume' && msg.id === selectedId) { at.files = resumeHits(msg.id, at.q); at.sel = 0; drawAt(); }
  }
  function onInput(e) {
    if (!chat()) return;
    // Typing brings the chat to its latest message, so you answer what you can see.
    const c = document.getElementById('conversation');
    if (c && c.scrollHeight - c.scrollTop - c.clientHeight > 40) c.scrollTo({ top: c.scrollHeight, behavior: 'smooth' });
    linkify.pasted = e.inputType === 'insertFromPaste';
    if (linkify.pasted || /\s/.test(e.data || '') || e.inputType === 'insertLineBreak') { const was = e.target.value; linkify(e.target); if (e.target.value !== was) syncHl(); }
    if (resumeCheck(e.target)) return;
    const m = atQuery(e.target), a = agents.get(selectedId);
    if (!m || !a) return closeAt();
    at = { kind: m.kind, start: m.start, q: m.q, files: at && at.kind === m.kind ? at.files : [], sel: 0 };
    if (m.kind === '@') api.send({ type: 'chatFiles', id: selectedId, cwd: a.cwd, q: m.q, seq: ++atSeq });
    else { if (!catalog.has(a.cwd)) api.send({ type: 'catalog', cwd: a.cwd }); at.files = slashMatches(a.cwd, m.q); drawAt(); }
  }
  function onFiles(msg) {
    if (!at || at.kind !== '@' || msg.seq !== atSeq || msg.id !== selectedId) return;
    at.files = msg.files || []; at.sel = 0; drawAt();
  }
  function onCatalog(msg) {
    catalog.set(msg.cwd, msg.items || []);
    const a = agents.get(selectedId);
    if (at && at.kind === '/' && a && a.cwd === msg.cwd) { at.files = slashMatches(a.cwd, at.q); drawAt(); }
    syncHl(); // its /commands can be coloured now
  }
  function drawAt() {
    const l = atList();
    const esc = (s) => String(s).replace(/[&<>]/g, '');
    // The typed part of each name is marked, so it's clear why it matched.
    const mark = (name) => { const j = at.q ? name.toLowerCase().indexOf(at.q.toLowerCase()) : -1; return j < 0 ? esc(name) : esc(name.slice(0, j)) + '<mark>' + esc(name.slice(j, j + at.q.length)) + '</mark>' + esc(name.slice(j + at.q.length)); };
    const size = (b) => b >= 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB';
    const row = (f, k) => {
      if (at.kind === 'resume') return `<div class="at-i${k === at.sel ? ' sel' : ''}" data-k="${k}"><b>${mark(f.title)}</b><span>${fmtTimeAgo(f.mtime)} · ${size(f.size)}</span></div>`;
      if (at.kind === '/') return `<div class="at-i${k === at.sel ? ' sel' : ''}" data-k="${k}"><b>/${mark(f.name)}</b><span class="d">${esc(f.desc || '')}</span></div>`;
      const i = f.lastIndexOf('/'); return `<div class="at-i${k === at.sel ? ' sel' : ''}" data-k="${k}"><b>${mark(f.slice(i + 1))}</b><span>${i > 0 ? esc(f.slice(0, i)) : ''}</span></div>`;
    };
    l.innerHTML = at && at.files.length ? at.files.map(row).join('') : '';
    l.classList.toggle('open', !!(at && at.files.length));
    l.classList.toggle('slash', !!(at && at.kind === '/'));
    l.classList.toggle('resume', !!(at && at.kind === 'resume'));
    const sel = l.querySelector('.sel'); if (sel) sel.scrollIntoView({ block: 'nearest' });
  }
  function closeAt() { at = null; drawAt(); }
  function pickAt(k) {
    const t = box(), f = at && at.files[k]; if (!f) return closeAt();
    if (at.kind === 'resume') { api.send({ type: 'termInput', id: selectedId, data: '/resume ' + f.id + '\r' }); t.value = ''; grow(t); return closeAt(); }
    const end = t.selectionStart, ins = at.kind === '/' ? f.insert : '@' + f + ' ';
    t.value = t.value.slice(0, at.start) + ins + t.value.slice(end); t.selectionStart = t.selectionEnd = at.start + ins.length;
    closeAt(); grow(t); t.focus(); resumeCheck(t);
  }

  // ── Drafts per agent: what you've typed stays with the agent it was for ──
  const drafts = new Map(); let draftFor = null;
  function syncDraft() {
    if (draftFor === selectedId) return;
    micStop(); // a take belongs to the agent it started on
    if (draftFor != null) drafts.set(draftFor, box().value);
    box().value = drafts.get(selectedId) || ''; grow(box()); hist = -1; closeAt();
    draftFor = selectedId;
  }

  // Switching Chat ↔ Terminal keeps what you were typing: the reply box's text goes into the CLI's prompt (not sent),
  // and the CLI's prompt comes into the reply box. ponytail: a draft with images stays in the chat (the CLI can't take them as typed).
  function carryDraft(from, to) {
    const id = selectedId, x = typeof xterms !== 'undefined' && xterms.get(id), t = box(); if (!x) return;
    if (from === 'conversation' && to === 'terminal') {
      const a = atts.get(id); if (a && a.list.length) return;
      const v = expandLinks(expandPastes(t.value, a), a); if (!v.trim()) return;
      api.send({ type: 'termInput', id, data: '\x1b[200~' + v.replace(/\r\n?/g, '\n') + '\x1b[201~' });
      t.value = ''; drafts.set(id, ''); if (a) { a.pastes = []; a.files = []; a.links = []; } grow(t); drawAtt();
    } else if (from === 'terminal' && to === 'conversation') {
      if (typeof readPromptBox !== 'function' || t.value.trim()) return;
      const b = x.terminal.buffer.active, rows = []; for (let y = Math.max(0, b.length - 40); y < b.length; y++) rows.push(b.getLine(y)?.translateToString(true) || '');
      if (screenDialog(rows)) return; // a dialog is up: its Ctrl+C would cancel it
      const v = readPromptBox(x.terminal);
      if (!v || !v.trim() || /^Try "/.test(v) || /^\d+\.\s/.test(v)) return; // the box's own hint, or a dialog's option
      t.value = v; drafts.set(id, v); grow(t);
      api.send({ type: 'termInput', id, data: '\x03' }); // Ctrl+C with text in the box clears it, as in the CLI
    }
  }
  function setDraft(id, text) {
    drafts.set(id, text);
    if (draftFor === id) { const t = box(); t.value = text; grow(t); t.focus(); t.selectionStart = t.selectionEnd = text.length; }
  }
  // The reply box keeps focus while the Chat view is open: a click on anything that isn't itself typed into (the thread,
  // a chip, the agent list) hands it back, unless you selected text or a panel holds focus.
  const shown = () => chat() && selectedId != null && !!document.getElementById('conversation')?.classList.contains('open');
  document.addEventListener('click', () => {
    if (!shown()) return;
    const ae = document.activeElement;
    if (ae && (ae.matches('input, textarea, select, [contenteditable="true"]') || ae.closest('[role="dialog"], [role="menu"], [role="listbox"]'))) return;
    if (String(getSelection() || '').trim()) return;
    box().focus({ preventScroll: true });
  });
  window.addEventListener('focus', () => { if (shown() && (!document.activeElement || document.activeElement === document.body)) box().focus({ preventScroll: true }); });

  // With the box empty, a question or permission card takes the terminal's keys: 1–9 pick, Esc denies.
  function cardKey(e) {
    if (box().value) return false;
    const tail = document.querySelector('#conversation .tail');
    if (/^[1-9]$/.test(e.key)) { const b = tail && (tail.querySelector(`[data-pick="${+e.key - 1}"]`) || tail.querySelector(`[data-keys="${e.key}"]`) || tail.querySelectorAll('.choices button')[+e.key - 1]); if (b) { b.click(); return true; } }
    if (e.key === 'Escape') { const b = tail && tail.querySelector('[data-keys="esc"]'); if (b) { b.click(); return true; } }
    return false;
  }

  let lastEsc = 0;
  function onKey(e) {
    const t = e.target;
    if (at && at.files.length && chat()) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); at.sel = (at.sel + (e.key === 'ArrowDown' ? 1 : at.files.length - 1)) % at.files.length; drawAt(); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pickAt(at.sel); return; }
      if (e.key === 'Escape') { e.preventDefault(); closeAt(); return; }
    }
    if (chat() && cardKey(e)) { e.preventDefault(); return; }
    // A tag goes in one keystroke: Backspace right after "[Image #1]" (or Delete right before it) removes it whole.
    if ((e.key === 'Backspace' || e.key === 'Delete') && t.selectionStart === t.selectionEnd) {
      const at = t.selectionStart, before = t.value.slice(0, at), after = t.value.slice(at);
      const ln = ((atts.get(selectedId) || {}).links || []).find(l => e.key === 'Backspace' ? before.endsWith(l.tok) : after.startsWith(l.tok)); // a link's name goes whole
      if (ln) { e.preventDefault(); const i = e.key === 'Backspace' ? at - ln.tok.length : at; t.value = t.value.slice(0, i) + t.value.slice(i + ln.tok.length); t.selectionStart = t.selectionEnd = i; grow(t); return; }
      const m = e.key === 'Backspace' ? /\[(?:Image #\d+|Pasted text #\d+[^\]]*)\] ?$/.exec(before) : /^\[(?:Image #\d+|Pasted text #\d+[^\]]*)\] ?/.exec(after);
      if (m) {
        e.preventDefault();
        t.value = e.key === 'Backspace' ? before.slice(0, m.index) + after : before + after.slice(m[0].length);
        t.selectionStart = t.selectionEnd = e.key === 'Backspace' ? m.index : at; grow(t); pruneAtt(); return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); return; }
    if (!chat()) return;
    if (e.key === 'Escape' && order().classList.contains('busy')) { e.preventDefault(); chatUi.keys(['\x1b']); return; }
    // Esc Esc with an empty box, as in the CLI: its rewind picker (shown over the chat by chat-ui's dialog peek).
    if (e.key === 'Escape' && !t.value) { e.preventDefault(); if (Date.now() - lastEsc < 600) { chatUi.keys(['\x1b', '\x1b']); lastEsc = 0; } else lastEsc = Date.now(); return; }
    // History, like the CLI: ↑ at the start of the box steps back through your prompts, ↓ comes forward again.
    const ps = prompts();
    // On the first line ↑ goes back, on the last line ↓ comes forward; the caret lands at the end of what's recalled.
    const firstLine = !t.value.slice(0, t.selectionStart).includes('\n'), lastLine = !t.value.slice(t.selectionEnd).includes('\n');
    const recall = (v) => { t.value = v; grow(t); t.selectionStart = t.selectionEnd = v.length; };
    if (e.key === 'ArrowUp' && firstLine && ps.length && hist < ps.length - 1) {
      e.preventDefault(); if (hist < 0) draft = t.value;
      hist++; recall(ps[ps.length - 1 - hist]);
    } else if (e.key === 'ArrowDown' && hist >= 0 && lastLine) {
      e.preventDefault(); hist--; recall(hist < 0 ? draft : ps[ps.length - 1 - hist]);
    }
  }
  // Pasted files: a screenshot goes through main like Alt+V in the terminal; an image file copied in Explorer is attached
  // by path; any other file drops its path into the box. Plain text pastes as usual.
  function onPaste(e) {
    if (!chat() || selectedId == null) return;
    const files = [...(e.clipboardData?.files || [])];
    if (files.length && addFiles(files)) { e.preventDefault(); return; }
    const txt = e.clipboardData?.getData('text/plain') || '';
    // Explorer's "Copy as path" (one or more "C:\…\file.ext" lines): each becomes a chip, not a long path
    const paths = txt.trim().split(/\r?\n/).map(l => l.trim().replace(/^"(.*)"$/, '$1'));
    if (paths.length <= 20 && paths.every(l => pathRef(l))) { e.preventDefault(); paths.forEach(addFileRef); drawAtt(); return; }
    if (txt.length > 1500 || txt.split('\n').length > 20) { e.preventDefault(); addPaste(txt.replace(/\r\n?/g, '\n')); }
  }
  // Files dropped anywhere on the Chat view do the same (the app-wide drop handler would type them into the terminal unseen).
  const pane = document.getElementById('term'), hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  pane.addEventListener('dragover', (e) => { if (!chat() || !hasFiles(e)) return; e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = 'copy'; order().classList.add('drop'); });
  pane.addEventListener('dragleave', (e) => { if (!pane.contains(e.relatedTarget)) order().classList.remove('drop'); });
  pane.addEventListener('drop', (e) => { order().classList.remove('drop'); if (!chat() || !e.dataTransfer?.files.length) return; e.preventDefault(); e.stopPropagation(); addFiles([...e.dataTransfer.files]); box().focus(); });

  document.getElementById('term-order-input').addEventListener('paste', onPaste);
  document.getElementById('term-order-input').addEventListener('input', onInput);
  document.getElementById('term-order-input').addEventListener('blur', () => setTimeout(closeAt, 150));
  document.getElementById('chat-at').addEventListener('mousedown', (e) => { const i = e.target.closest('.at-i'); if (i) { e.preventDefault(); pickAt(+i.dataset.k); } });
  document.getElementById('chat-plus').addEventListener('click', (e) => { e.stopPropagation(); catalogUi.isOpen() ? catalogUi.close() : openPicker(); });
  document.getElementById('chat-plus').addEventListener('mousedown', (e) => e.stopPropagation()); // the picker's outside-click close would reopen it
  document.getElementById('chat-chips').addEventListener('click', (e) => chatUi.onClick(e, agents.get(selectedId), null));
  document.getElementById('term-order-input').addEventListener('input', pruneAtt);
  // ✕ on a thumbnail removes the image and its tag; a click on the picture opens it full size (chat-ui.js).
  document.getElementById('chat-att').addEventListener('click', (e) => {
    const chip = e.target.closest('.att'); if (!chip) return;
    const x = e.target.closest('.att-x'), t = box();
    if (chip.dataset.f) { // a file chip: ✕ drops it and its tag, a click opens the file
      e.stopPropagation();
      const n = +chip.dataset.f, f = ((atts.get(selectedId) || {}).files || []).find(q => q.n === n);
      if (!x) { if (f) api.send({ type: 'openFileAt', cwd: '', file: f.path, line: 0 }); return; }
      t.value = t.value.replace(new RegExp(`\\[File #${n}[^\\]]*\\] ?`), ''); grow(t); pruneAtt(); t.focus();
      return;
    }
    if (chip.dataset.p) { // a pasted-text chip: ✕ drops it, a click puts the text back into the box
      e.stopPropagation();
      const n = +chip.dataset.p, re = new RegExp(`\\[Pasted text #${n}[^\\]]*\\] ?`);
      const p = ((atts.get(selectedId) || {}).pastes || []).find(q => q.n === n);
      t.value = t.value.replace(re, () => (x || !p ? '' : p.text)); grow(t); pruneAtt(); t.focus(); // a function: the text may hold "$&"
      return;
    }
    if (!x) return;
    e.stopPropagation();
    const n = chip.dataset.n;
    t.value = t.value.split(`[Image #${n}] `).join('').split(`[Image #${n}]`).join(''); grow(t); pruneAtt(); t.focus();
  }, true);
  // Typing anywhere in the Chat view goes to the box, like the CLI's always-live prompt: a plain key pressed while
  // focus isn't in another field moves focus here first, so the character lands in the box.
  // Ctrl+` flips Chat ↔ Terminal (from either). In the Chat view, Ctrl+F finds in the chat and Ctrl+↑/↓ jump between
  // your prompts — the terminal's own versions would act on the hidden terminal.
  document.addEventListener('keydown', (e) => {
    if (worldView || selectedId == null) return;
    if (e.ctrlKey && !e.shiftKey && !e.altKey && e.code === 'Backquote') { e.preventDefault(); e.stopPropagation(); switchTermTab(termTab === 'conversation' ? 'terminal' : 'conversation'); if (termTab === 'terminal') { const x = xterms.get(selectedId); if (x) x.terminal.focus(); } return; }
    if (!chat()) return;
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && hotkeyLetter(e) === 'f') { e.preventDefault(); e.stopPropagation(); chatUi.openFind(); return; }
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) { e.preventDefault(); e.stopPropagation(); chatUi.jumpPrompt(e.key === 'ArrowUp' ? -1 : 1); }
  }, true);

  document.addEventListener('keydown', (e) => {
    if (!chat() || selectedId == null || e.ctrlKey || e.metaKey || e.altKey || e.key.length !== 1) return;
    const a = document.activeElement;
    if (a && (a === box() || /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) || a.isContentEditable)) return;
    if (document.querySelector('.chat-lightbox, #settings-overlay[style*="flex"], #search-overlay[style*="flex"]')) return;
    if (order().classList.contains('dead')) return;
    if (cardKey(e)) { e.preventDefault(); return; } // an open question/permission card takes 1–9 first, as in the terminal
    box().focus();
  }, true);

  // The box's [Image #N] / [Pasted text #N · …] tags read as chips: a layer behind the textarea draws the same text, the
  // tags in a tint, transparent otherwise, kept on the textarea's size and scroll.
  const hl = document.createElement('div'); hl.id = 'chat-hl'; hl.setAttribute('aria-hidden', 'true');
  box().before(hl);
  const askedCat = new Set(); // folders whose command list was asked for once
  // A link in the box reads as its name, in link colour: a ClickUp task by its real name, a GitHub PR as "repo #N",
  // anything else as site + path (chatUi.linkLabel). The box holds the name; Send puts the address back.
  // ponytail: a name edited by hand stops being a link (Backspace at its end removes it whole, as with the other tags).
  const URL_RE = /https?:\/\/[^\s<>"]*[^\s<>".,;:!?)\]']/;
  function linkify(t) {
    const id = selectedId; if (id == null || !URL_RE.test(t.value)) return;
    const a = attOf(id), v = t.value; a.links ||= [];
    let out = '', last = 0, caret = t.selectionStart;
    for (const m of v.matchAll(new RegExp(URL_RE.source, 'g'))) {
      const end = m.index + m[0].length;
      if (end === v.length && end === t.selectionStart && !linkify.pasted) continue; // still being typed
      const l = chatUi.linkLabel(m[0]); if (!l) continue;
      let tok = l.name; for (let k = 2; a.links.some(x => x.tok === tok && x.url !== m[0]); k++) tok = `${l.name} (${k})`;
      a.links.push({ tok, url: m[0] });
      out += v.slice(last, m.index) + tok; last = end;
      if (caret >= end) caret += tok.length - m[0].length;
    }
    if (!last) return;
    t.value = out + v.slice(last); t.selectionStart = t.selectionEnd = caret; grow(t);
  }
  const expandLinks = (text, a) => ((a && a.links) || []).reduce((s, l) => s.includes(l.tok) ? s.replace(l.tok, l.url) : s, text);
  // A title that came in after the link was put in the box (the page's, or a ClickUp task's): swap it in.
  chatUi.linkWaiters.add(() => {
    const a = atts.get(selectedId), t = box(); if (!a || !a.links) return;
    for (const l of a.links) {
      const n = chatUi.linkLabel(l.url).name, i = t.value.indexOf(l.tok);
      if (n === l.tok || i < 0 || a.links.some(x => x !== l && x.tok === n)) continue;
      const s = t.selectionStart; t.value = t.value.slice(0, i) + n + t.value.slice(i + l.tok.length); if (s > i) t.selectionStart = t.selectionEnd = Math.max(i + n.length, s + n.length - l.tok.length);
      l.tok = n;
    }
    grow(t);
  });
  function syncHl() {
    const t = box(), v = t.value;
    // a /command or /skill this agent has (from its catalog) reads in the brand colour, like the CLI
    const a = typeof agents === 'undefined' ? null : agents.get(selectedId), names = new Set((catalog.get(a && a.cwd) || []).filter(i => i.insert && i.insert.startsWith('/')).map(i => i.insert.trim().split(/\s/)[0].toLowerCase()));
    if (a && !catalog.has(a.cwd) && !askedCat.has(a.cwd) && /(^|\s)\/[\w:-]/.test(v)) { askedCat.add(a.cwd); api.send({ type: 'catalog', cwd: a.cwd }); }
    const cmd = /(^|\s)(\/[\w:.-]+)/g, hasCmd = names.size && [...v.matchAll(cmd)].some(m => names.has(m[2].toLowerCase()));
    const esc = (s) => s.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
    const toks = ((atts.get(typeof agents === 'undefined' ? null : selectedId) || {}).links || []).map(l => l.tok).filter(k => v.includes(k));
    // Link names are drawn by this layer in link colour, so the box's own text goes see-through while there are any.
    t.classList.toggle('hl-txt', toks.length > 0); hl.classList.toggle('txt', toks.length > 0);
    if (!/\[(Image|Pasted text|File) #\d+/.test(v) && !hasCmd && !toks.length) { if (hl.innerHTML) hl.innerHTML = ''; hl.hidden = true; return; }
    hl.hidden = false;
    let h = esc(v).replace(/\[(?:Image #\d+|Pasted text #\d+[^\]]*|File #\d+[^\]]*)\]/g, m => `<mark>${m}</mark>`)
      .replace(cmd, (m, sp, c) => names.has(c.toLowerCase()) ? `${sp}<mark class="cmd">${c}</mark>` : m);
    for (const k of toks.sort((x, y) => y.length - x.length)) h = h.split(esc(k)).join(`<mark class="lnk">${esc(k)}</mark>`);
    hl.innerHTML = h + '\n';
    hl.style.top = t.offsetTop + 'px'; hl.style.left = t.offsetLeft + 'px'; hl.style.width = t.clientWidth + 'px'; hl.style.height = t.clientHeight + 'px';
    hl.scrollTop = t.scrollTop;
  }
  box().addEventListener('input', syncHl); box().addEventListener('scroll', () => { hl.scrollTop = box().scrollTop; });
  new ResizeObserver(syncHl).observe(box()); new ResizeObserver(syncHl).observe(order()); // chips above push the box down

  // ── Mic: dictation through Windows' offline recognizer (main.js runs dictate.ps1). Words go in at the caret as you
  // talk: the phrase still being spoken shows live and settles when the recognizer is sure. Typing, sending, Esc or
  // switching agent ends the take; what was written stays. ──
  const mic = document.getElementById('chat-mic');
  function drawMic() {
    if (!mic) return;
    mic.classList.toggle('on', !!dict); mic.classList.toggle('live', !!(dict && dict.live));
    mic.setAttribute('aria-pressed', String(!!dict));
    mic.title = dict ? 'Stop dictating (Esc)' : 'Dictate (Ctrl+Shift+M)';
  }
  function micStart() {
    const t = box();
    dict = { id: selectedId, pre: t.value.slice(0, t.selectionStart), post: t.value.slice(t.selectionEnd), said: '', live: false };
    api.send({ type: 'dictateStart' }); drawMic(); t.focus();
  }
  function micStop() { if (!dict) return; dict = null; api.send({ type: 'dictateStop' }); drawMic(); }
  function micToggle() { dict ? micStop() : micStart(); }
  function onDictation(m) {
    if (!dict) return;
    if (dict.id !== selectedId) return micStop();
    if (m.t === 'ready') dict.live = true;
    else if (m.t === 'hyp' || m.t === 'final') {
      const words = (dict.said + ' ' + m.text).trim(), t = box();
      if (m.t === 'final') dict.said = words;
      t.value = dictJoin(dict.pre, words, dict.post);
      const at = t.value.length - dict.post.length; t.setSelectionRange(at, at);
      t.dispatchEvent(new Event('input')); // grows the box and redraws its state like typing would
    } else if (m.t === 'error') { showToast('Mic: ' + m.text); dict = null; }
    else if (m.t === 'end') dict = null;
    drawMic();
  }
  if (mic) mic.addEventListener('click', micToggle);
  // Typing takes over from the mic (Esc just stops it); sending or switching agent ends the take too.
  box().addEventListener('keydown', (e) => { if (!dict) return; if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); micStop(); } else if (e.key.length === 1 || e.key === 'Backspace' || e.key === 'Delete' || e.key === 'Enter') micStop(); }, true);
  document.addEventListener('keydown', (e) => { if (e.ctrlKey && e.shiftKey && e.code === 'KeyM' && chat()) { e.preventDefault(); micToggle(); } });

  window.chatComposer = { send, insert, onKey, onFiles, onSessions, setDraft, carryDraft, onCatalog, onImageSaved, drawAtt, onDictation, micStop };
})();
