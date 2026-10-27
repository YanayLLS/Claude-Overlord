// The Chat view's composer, doing what the CLI's prompt box does: Enter sends (the prompt shows at once, dimmed,
// until the transcript has it), Esc interrupts a working agent, ↑/↓ walk your earlier prompts, "/" or + opens the
// skills/commands picker, a pasted image goes to the agent's prompt as [Image #N] and shows here as a thumbnail.
(function () {
  const box = () => document.getElementById('term-order-input');
  const order = () => document.getElementById('term-order');
  const chat = () => termTab === 'conversation' && !worldView;
  let hist = -1, draft = '';
  const grow = (t) => { t.style.height = 'auto'; t.style.height = t.scrollHeight + 'px'; order().classList.toggle('blank', !t.value.trim()); };

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
  const escA = (s) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  function drawAtt() {
    syncDraft(); // called when the Chat view shows another agent: its own draft and images
    const a = atts.get(selectedId), list = a ? a.list : [], pastes = (a && a.pastes) || [];
    document.getElementById('chat-att').innerHTML = list.map(x => `<span class="att${x.saving ? ' saving' : ''}" data-n="${x.n}"><img src="${x.url}" alt=""><b>${x.n}</b><button type="button" class="att-x" title="Remove" aria-label="Remove image ${x.n}">×</button></span>`).join('')
      + pastes.map(x => `<span class="att doc" data-p="${x.n}" title="${escA(x.text.split('\n').slice(0, 8).join('\n'))}"><span class="doc-i">¶</span><span class="doc-t"><b>Pasted text #${x.n}</b><small>${x.lines} lines · click to expand</small></span><button type="button" class="att-x" title="Remove" aria-label="Remove pasted text ${x.n}">×</button></span>`).join('');
    order().classList.toggle('has-att', list.length + pastes.length > 0);
  }
  // A tag deleted from the text drops its image or pasted text (and its chip).
  function pruneAtt() {
    const a = atts.get(selectedId); if (!a || (!a.list.length && !(a.pastes || []).length)) return;
    const v = box().value, used = new Set([...v.matchAll(TAG)].map(m => +m[1])), usedP = new Set([...v.matchAll(PASTE)].map(m => +m[1]));
    const keep = a.list.filter(x => used.has(x.n)), keepP = (a.pastes || []).filter(x => usedP.has(x.n));
    if (keep.length !== a.list.length || keepP.length !== (a.pastes || []).length) { a.list = keep; a.pastes = keepP; if (!keep.length) a.next = 1; if (!keepP.length) a.nextP = 1; drawAtt(); }
  }
  function addPaste(text) {
    const a = attOf(selectedId); a.pastes = a.pastes || []; a.nextP = a.nextP || 1;
    const x = { n: a.nextP++, text, lines: text.split('\n').length }; a.pastes.push(x);
    insert(`[Pasted text #${x.n} · ${x.lines} lines] `); drawAtt();
  }
  const expandPastes = (text, a) => text.replace(PASTE, (m, n) => { const x = ((a && a.pastes) || []).find(p => p.n === +n); return x ? x.text : m; });
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
      } else if (p) { insert((/\s/.test(p) ? `"${p}"` : p) + ' '); took = true; } // any other file: its path, like the CLI
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
    pruneAtt();
    const a = atts.get(id), shown = inp.value.trim(), text = expandPastes(inp.value, a).trim(), list = a ? a.list.splice(0) : [];
    if (a) { a.next = 1; a.pastes = []; a.nextP = 1; }
    if (!text) { if (chat() && order().classList.contains('busy')) chatUi.keys(['\x1b']); return; } // empty + working: Stop
    const held = list.some(x => x.saving);
    if (chat()) chatUi.addPending(id, shown, list.map(x => x.url), held, text); // shows the box as typed (paste chips), matches the full text
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
  function onInput(e) {
    if (!chat()) return;
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
  }
  function drawAt() {
    const l = atList();
    const esc = (s) => String(s).replace(/[&<>]/g, '');
    // The typed part of each name is marked, so it's clear why it matched.
    const mark = (name) => { const j = at.q ? name.toLowerCase().indexOf(at.q.toLowerCase()) : -1; return j < 0 ? esc(name) : esc(name.slice(0, j)) + '<mark>' + esc(name.slice(j, j + at.q.length)) + '</mark>' + esc(name.slice(j + at.q.length)); };
    const row = (f, k) => {
      if (at.kind === '/') return `<div class="at-i${k === at.sel ? ' sel' : ''}" data-k="${k}"><b>/${mark(f.name)}</b><span class="d">${esc(f.desc || '')}</span></div>`;
      const i = f.lastIndexOf('/'); return `<div class="at-i${k === at.sel ? ' sel' : ''}" data-k="${k}"><b>${mark(f.slice(i + 1))}</b><span>${i > 0 ? esc(f.slice(0, i)) : ''}</span></div>`;
    };
    l.innerHTML = at && at.files.length ? at.files.map(row).join('') : '';
    l.classList.toggle('open', !!(at && at.files.length));
    l.classList.toggle('slash', !!(at && at.kind === '/'));
    const sel = l.querySelector('.sel'); if (sel) sel.scrollIntoView({ block: 'nearest' });
  }
  function closeAt() { at = null; drawAt(); }
  function pickAt(k) {
    const t = box(), f = at && at.files[k]; if (!f) return closeAt();
    const end = t.selectionStart, ins = at.kind === '/' ? f.insert : '@' + f + ' ';
    t.value = t.value.slice(0, at.start) + ins + t.value.slice(end); t.selectionStart = t.selectionEnd = at.start + ins.length;
    closeAt(); grow(t); t.focus();
  }

  // ── Drafts per agent: what you've typed stays with the agent it was for ──
  const drafts = new Map(); let draftFor = null;
  function syncDraft() {
    if (draftFor === selectedId) return;
    if (draftFor != null) drafts.set(draftFor, box().value);
    box().value = drafts.get(selectedId) || ''; grow(box()); hist = -1; closeAt();
    draftFor = selectedId;
  }

  // With the box empty, a question or permission card takes the terminal's keys: 1–9 pick, Esc denies.
  function cardKey(e) {
    if (box().value) return false;
    const tail = document.querySelector('#conversation .tail');
    if (/^[1-9]$/.test(e.key)) { const b = tail && (tail.querySelector(`[data-pick="${+e.key - 1}"]`) || tail.querySelector(`[data-keys="${e.key}"]`) || tail.querySelectorAll('.choices button')[+e.key - 1]); if (b) { b.click(); return true; } }
    if (e.key === 'Escape') { const b = tail && tail.querySelector('[data-keys="esc"]'); if (b) { b.click(); return true; } }
    return false;
  }

  function onKey(e) {
    const t = e.target;
    if (at && at.files.length && chat()) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); at.sel = (at.sel + (e.key === 'ArrowDown' ? 1 : at.files.length - 1)) % at.files.length; drawAt(); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pickAt(at.sel); return; }
      if (e.key === 'Escape') { e.preventDefault(); closeAt(); return; }
    }
    if (chat() && cardKey(e)) { e.preventDefault(); return; }
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); return; }
    if (!chat()) return;
    if (e.key === 'Escape' && order().classList.contains('busy')) { e.preventDefault(); chatUi.keys(['\x1b']); return; }
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

  window.chatComposer = { send, insert, onKey, onFiles, onCatalog, onImageSaved, drawAtt };
})();
