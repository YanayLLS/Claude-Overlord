// Chat tab: the agent's transcript drawn like a chat app — markdown replies, your prompts as bubbles, tools as
// cards that open to their output. Fed by the timeline events main.js sends (parseLineForTimeline); index.html's
// renderConversation lays them out, this file turns one event into HTML and handles clicks inside the view.
(function () {
  const escH = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  // Events never change once received, so each is rendered once. The cache is dropped when md-bundle lands.
  const toolCache = new WeakMap();
  let cache = new WeakMap(), mdReady = !!window.marked, mdLoading = false;
  function md(src, cwd) {
    if (!mdReady) {
      if (!mdLoading) mdLoading = true, window.docsUi.loadMd().then(() => { mdReady = true; cache = new WeakMap(); if (typeof renderConversation === 'function') renderConversation(); }, () => {});
      return `<p>${escH(src)}</p>`;
    }
    return window.docsUi.toHtml(src, (cwd || '').replace(/\\/g, '/') + '/_'); // relative links resolve against the agent's folder
  }
  function evHtml(ev, done, name, cwd) {
    if (ev.type === 'tool' || ev.type === 'subtask') { // the card changes once, when its result (done) arrives
      const c = toolCache.get(ev); if (c && c[0] === done) return c[1];
      const out = done && done.text ? done.text.trim() : '';
      const cls = `msg tool${ev.type === 'subtask' ? ' sub' : ''}${!done && ev.toolId ? ' running' : ''}${done && done.err ? ' err' : ''}`;
      const head = `<span class="t">${escH(ev.name || '')}</span><span class="f" title="${escH(ev.text || '')}">${escH(ev.text || '')}</span>`;
      const h = out ? `<details class="${cls}" data-tid="${escH(ev.toolId)}"><summary>${head}</summary><pre>${escH(out)}</pre></details>` : `<div class="${cls}">${head}</div>`;
      toolCache.set(ev, [done, h]);
      return h;
    }
    let h = cache.get(ev);
    if (h != null) return h;
    if (ev.type === 'prompt') h = `<div class="msg user"><div class="eyebrow">You<em>${escH(fmtTs(ev.ts))}</em></div><div class="bubble">${escH(ev.text)}</div></div>`;
    else if (ev.type === 'text') h = `<div class="msg ai"><div class="eyebrow">${escH(name)}<em>${escH(fmtTs(ev.ts))}</em></div><div class="md">${md(ev.text, cwd)}</div></div>`;
    else if (ev.type === 'turn') h = `<div class="msg turn">${escH(ev.text)}</div>`;
    else h = '';
    if (mdReady || ev.type !== 'text') cache.set(ev, h);
    return h;
  }
  // Copy buttons on code blocks and links, as in the Docs column.
  function onClick(e, cwd) {
    const copy = e.target.closest('.md-copy');
    if (copy) { navigator.clipboard.writeText(copy.closest('.md-code').querySelector('code').textContent).then(() => { copy.textContent = 'Copied'; setTimeout(() => { copy.textContent = 'Copy'; }, 1200); }); return; }
    const a = e.target.closest('a[href]'); if (!a) return;
    e.preventDefault();
    const c = classifyHref(a.dataset.href || a.getAttribute('href'), (cwd || '').replace(/\\/g, '/') + '/_');
    if (c.kind === 'external') api.send({ type: 'openUrl', url: c.url });
    else if (c.kind === 'doc') api.send({ type: 'docOpen', paths: [c.path] });
    else if (c.kind === 'file') api.send({ type: 'docOpenWith', path: c.path });
  }
  window.chatUi = { evHtml, onClick };
})();
