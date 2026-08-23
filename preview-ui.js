// Preview pane controller. DOM in preview-ui-dom.js; device emulation in preview-ui-device.js.
// Exposes window.preview = { toggle, setUrl, setActiveAgent } for the inline script to drive.
(function () {
  let visible = false;
  let currentUrl = '';
  let activeAgentId = null;
  let errorCount = 0;
  let pendingFrame = false;
  let refs = null;
  let deviceCtl = null;

  function toggle() {
    visible = !visible;
    const content = document.getElementById('content');
    refs.col.classList.toggle('open', visible);
    refs.handle.classList.toggle('open', visible);
    refs.toggleBtn.classList.toggle('active', visible);
    content.classList.toggle('preview-open', visible);
    if (visible) {
      // Equal-third pixel widths on toggle ON; drag handles can adjust afterwards.
      const term = document.getElementById('term');
      const w = Math.max(280, Math.floor((content.clientWidth - 8) / 3));
      if (term) term.style.width = w + 'px';
      refs.col.style.width = w + 'px';
    }
    api.send({ type: 'previewToggle', visible });
    if (visible) { reportBounds(); showUrl(currentUrl); }
  }

  function reportBounds() {
    if (!visible || pendingFrame) return;
    pendingFrame = true;
    requestAnimationFrame(() => {
      pendingFrame = false;
      api.send({ type: 'previewSetBounds', bounds: deviceCtl.getBounds(refs.host.getBoundingClientRect()) });
    });
  }

  function setUrlValue(v) {
    if (document.activeElement !== refs.urlInput) refs.urlInput.value = v;
  }

  // Presentational only. The pane displays the agent's working browser, so
  // focusing an agent (or detecting its dev server) must never navigate it or
  // wipe its error buffer — main.js already points a new server at that agent's
  // own view, and the real URL arrives back on 'previewLoaded'.
  function showUrl(url) {
    if (url) {
      setUrlValue(url); refs.statusEl.style.display = 'none';
    } else {
      setUrlValue(''); refs.statusEl.textContent = 'Waiting for localhost…';
      refs.statusEl.style.display = 'flex';
    }
  }

  function navigate(raw) {
    if (!raw) return;
    let url = raw;
    if (!/^[a-z]+:\/\//i.test(url)) url = 'http://' + url;
    if (!/^https?:\/\//i.test(url)) return;
    currentUrl = url;
    refs.statusEl.style.display = 'none';
    if (!visible) toggle();
    api.send({ type: 'previewLoad', url });
  }

  function setUrl(url) {
    if (url === currentUrl) return;
    currentUrl = url || '';
    if (visible) showUrl(currentUrl);
  }

  function setActiveAgent(id) {
    activeAgentId = (typeof id === 'number') ? id : null;
    deviceCtl.setAgent(activeAgentId);
    errorCount = 0;
    refs.errorBadge.textContent = '0 errors';
    refs.errorBadge.classList.remove('has-errors');
    refs.sendBtn.disabled = true;
    refs.clearBtn.disabled = true;
  }

  function onPreviewError(msg) {
    if (msg.id != null && msg.id !== activeAgentId) return;
    errorCount = msg.count;
    refs.errorBadge.textContent = `${errorCount} error${errorCount === 1 ? '' : 's'}`;
    refs.errorBadge.classList.toggle('has-errors', errorCount > 0);
    refs.sendBtn.disabled = errorCount === 0 || activeAgentId == null;
    refs.clearBtn.disabled = errorCount === 0;
  }

  function onPreviewLoaded(msg) {
    if (msg.id != null && msg.id !== activeAgentId) return;
    if (msg.url) setUrlValue(msg.url);
    refs.statusEl.style.display = 'none';
  }

  function onPreviewLoadFailed(msg) {
    if (msg.id != null && msg.id !== activeAgentId) return;
    refs.statusEl.textContent = `Load failed: ${msg.error}`;
    refs.statusEl.style.display = 'flex';
  }

  function init() {
    deviceCtl = window.PreviewDevice.create({ send: (m) => api.send(m), onChange: reportBounds });
    refs = window.PreviewDom.build({
      onToggle: toggle,
      onReload: () => api.send({ type: 'previewReload' }),
      onDevice: (e) => deviceCtl.showMenu(e),
      onRotate: () => deviceCtl.toggleOrientation(),
      onSend: () => { if (activeAgentId != null) api.send({ type: 'previewSendErrors', id: activeAgentId }); },
      onClear: () => api.send({ type: 'previewClearErrors', id: activeAgentId }),
      onNavigate: navigate,
    });
    deviceCtl.bind(refs);
    window.PreviewDom.setupResize(refs.handle, refs.col, reportBounds);
    window.addEventListener('resize', reportBounds);
    api.on((msg) => {
      if (msg.type === 'previewError') onPreviewError(msg);
      else if (msg.type === 'previewLoaded') onPreviewLoaded(msg);
      else if (msg.type === 'previewLoadFailed') onPreviewLoadFailed(msg);
    });
    window.preview = { toggle, setUrl, setActiveAgent };
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
