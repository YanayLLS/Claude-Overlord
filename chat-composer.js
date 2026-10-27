// The Chat view's composer, doing what the CLI's prompt box does: Enter sends (the prompt shows at once, dimmed,
// until the transcript has it), Esc interrupts a working agent, ↑/↓ walk your earlier prompts, "/" or + opens the
// skills/commands picker, a pasted image goes to the agent's prompt as [Image #N] and shows here as a thumbnail.
(function () {
  const box = () => document.getElementById('term-order-input');
  const order = () => document.getElementById('term-order');
  const chat = () => termTab === 'conversation' && !worldView;
  let hist = -1, draft = '';
  const grow = (t) => { t.style.height = 'auto'; t.style.height = t.scrollHeight + 'px'; order().classList.toggle('blank', !t.value.trim()); };

  // ── Images: shown the moment they're pasted or dropped (straight from the clipboard / file), handed to the agent's
  // prompt through main, which acks once it's in. A send made before every ack waits for them, so the image is
  // always in the prompt before the text and Enter land. Kept per agent: each one's images sit in its own prompt.
  const atts = new Map(); // agent id → { urls, waiting: Set<token>, queued: text to send once waiting empties | null }
  const attOf = (id) => { if (!atts.has(id)) atts.set(id, { urls: [], waiting: new Set(), queued: null }); return atts.get(id); };
  function drawAtt() {
    const a = atts.get(selectedId), urls = a ? a.urls : [];
    document.getElementById('chat-att').innerHTML = urls.map(u => `<img src="${u}" alt="">`).join('');
    order().classList.toggle('has-att', urls.length > 0);
  }
  function addFiles(files) {
    const id = selectedId; if (id == null) return false;
    let took = false;
    for (const f of files) {
      const p = api.getFilePath(f) || '';
      if (f.type && f.type.startsWith('image/')) {
        const a = attOf(id), tok = {}; a.urls.push(URL.createObjectURL(f)); a.waiting.add(tok); took = true;
        api.send(p ? { type: 'attachImage', id, path: p } : { type: 'pasteImage', id });
        setTimeout(() => { if (a.waiting.delete(tok)) flush(id); }, 4000); // no ack in 4 s: don't hold the prompt forever
      } else if (p) { insert((/\s/.test(p) ? `"${p}"` : p) + ' '); took = true; } // any other file: its path, like the CLI
    }
    drawAtt();
    return took;
  }
  // main's ack for one image (pasteImage / attachImage); a terminal-tab paste has nothing waiting and is ignored here.
  function onImagePasted(msg) {
    const a = atts.get(msg.id); if (!a || !a.waiting.size) return;
    a.waiting.delete(a.waiting.values().next().value);
    flush(msg.id);
  }
  function flush(id) {
    const a = atts.get(id); if (!a || a.waiting.size || a.queued == null) return;
    const text = a.queued; a.queued = null;
    setTimeout(() => deliver(id, text), 150); // Claude turns the pasted path into [Image #N] in ~30 ms
  }
  // questPrompt pastes the text and sends Enter in its own write once the paste has landed: the TUI swallows an Enter
  // written together with the text. An image-only prompt is just Enter on what's already in the agent's prompt.
  function deliver(id, text) {
    if (text) api.send({ type: 'questPrompt', id, text }); else api.send({ type: 'termInput', id, data: '\r' });
    chatUi.releasePending(id);
    if (chat()) renderConversation();
  }
  function send() {
    const inp = box(), text = inp.value.trim(), id = selectedId; if (id == null) return;
    const a = atts.get(id), imgs = a ? a.urls.splice(0) : [];
    if (!text && !imgs.length) { if (chat() && order().classList.contains('busy')) chatUi.keys(['\x1b']); return; } // empty + working: Stop
    const held = !!(a && a.waiting.size);
    if (chat()) chatUi.addPending(id, text, imgs, held);
    inp.value = ''; inp.style.height = ''; hist = -1; order().classList.add('blank'); drawAtt();
    if (held) { a.queued = text; if (chat()) renderConversation(); return; } // goes once main confirms the images are in
    deliver(id, text);
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
  let at = null, atSeq = 0; // { start, files, sel } while the list is open
  const atList = () => document.getElementById('chat-at');
  function atQuery(t) { const m = /(^|\s)@([^\s@]*)$/.exec(t.value.slice(0, t.selectionStart)); return m ? { start: t.selectionStart - m[2].length - 1, q: m[2] } : null; }
  function onInput(e) {
    if (!chat()) return;
    const m = atQuery(e.target), a = agents.get(selectedId);
    if (!m || !a) return closeAt();
    at = { start: m.start, q: m.q, files: at ? at.files : [], sel: 0 };
    api.send({ type: 'chatFiles', id: selectedId, cwd: a.cwd, q: m.q, seq: ++atSeq });
  }
  function onFiles(msg) {
    if (!at || msg.seq !== atSeq || msg.id !== selectedId) return;
    at.files = msg.files || []; at.sel = 0; drawAt();
  }
  function drawAt() {
    const l = atList();
    const esc = (s) => s.replace(/[&<>]/g, '');
    // The typed part of each name is marked, so it's clear why the file matched.
    const mark = (name) => { const j = at.q ? name.toLowerCase().indexOf(at.q.toLowerCase()) : -1; return j < 0 ? esc(name) : esc(name.slice(0, j)) + '<mark>' + esc(name.slice(j, j + at.q.length)) + '</mark>' + esc(name.slice(j + at.q.length)); };
    l.innerHTML = at && at.files.length ? at.files.map((f, k) => { const i = f.lastIndexOf('/'); return `<div class="at-i${k === at.sel ? ' sel' : ''}" data-k="${k}"><b>${mark(f.slice(i + 1))}</b><span>${i > 0 ? esc(f.slice(0, i)) : ''}</span></div>`; }).join('') : '';
    l.classList.toggle('open', !!(at && at.files.length));
  }
  function closeAt() { at = null; drawAt(); }
  function pickAt(k) {
    const t = box(), f = at && at.files[k]; if (!f) return closeAt();
    const end = t.selectionStart, ins = '@' + f + ' ';
    t.value = t.value.slice(0, at.start) + ins + t.value.slice(end); t.selectionStart = t.selectionEnd = at.start + ins.length;
    closeAt(); grow(t); t.focus();
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
    if (e.key === '/' && !t.value) { e.preventDefault(); openPicker(); return; }
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
    if (files.length && addFiles(files)) e.preventDefault();
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
  window.chatComposer = { send, insert, onKey, onFiles, onImagePasted, drawAtt };
})();
