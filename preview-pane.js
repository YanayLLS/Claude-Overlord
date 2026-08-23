// Presenter over the per-agent browser registry. Owns no views of its own —
// it shows whichever agent is focused inside the pane rectangle.
//
// Showing is PASSIVE. The view it displays is the agent's working browser: it
// may be three clicks deep into a checkout with live ref_N handles and a full
// error buffer. Focusing an agent must never navigate it or clear its state.
// Only explicit user action in the URL bar navigates.
const MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const IPAD_UA = 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

function createPreviewController({ window, registry, send, writeToAgent, isAlive = () => true }) {
  let agentId = null;
  let visible = false;
  let bounds = null;
  const defaultUA = new Map(); // agentId -> the UA that agent's view was born with

  const live = (id) => id != null && isAlive(id);
  const wc = () => (live(agentId) && registry.has(agentId) ? registry.ensure(agentId).webContents : null);

  // The embedded view must not keep keyboard focus after navigation — on Windows
  // it makes the parent window's buttons unresponsive.
  function restoreParentFocus() {
    if (window && !window.isDestroyed()) try { window.webContents.focus(); } catch {}
  }

  // registry.show() creates the view if it does not exist, so a dead agent id
  // must never reach it: previewSetBounds fires continuously during a window
  // resize and would otherwise build a fresh view and partition per frame for
  // an agent that has already been closed.
  function apply() {
    if (!visible || !live(agentId) || !bounds) { registry.hideAll(); return; }
    registry.show(agentId, bounds);
    restoreParentFocus();
  }

  function setAgent(id) {
    agentId = typeof id === 'number' && live(id) ? id : null;
    apply();
    const w = wc();
    if (w) send({ type: 'previewLoaded', id: agentId, url: w.getURL() });
  }

  // The registry notifies here on every navigation (see wireNavigation in
  // browser/view-wiring.js), so it always carries the id of the agent that
  // actually navigated — never a stale one from a focus switch that happened
  // while a load was in flight.
  function onAgentNavigated(id, url) {
    send({ type: 'previewLoaded', id, url });
    if (id === agentId) restoreParentFocus();
  }

  function load(url) {
    if (typeof url !== 'string' || !/^https?:\/\//.test(url) || !live(agentId)) return;
    const id = agentId;
    const actions = registry.actionsFor(id);
    if (!actions) return;
    actions.navigate(url).catch((e) => send({ type: 'previewLoadFailed', id, url, error: e.message }));
    apply();
  }

  // Each agent's view has its own session and so its own native UA; one shared
  // "default" would restore agent 2 to agent 1's user agent string.
  function setDevice(device) {
    const w = wc();
    if (!w) return;
    if (!defaultUA.has(agentId)) { try { defaultUA.set(agentId, w.getUserAgent()); } catch { defaultUA.set(agentId, ''); } }
    const ua = device === 'mobile' ? MOBILE_UA : (device === 'ipad' ? IPAD_UA : defaultUA.get(agentId));
    try { if (w.getUserAgent() !== ua) { w.setUserAgent(ua); w.reload(); } } catch {}
  }

  function sendErrors(id) {
    if (typeof id !== 'number' || !registry.has(id)) return;
    const errors = registry.errorsFor(id);
    if (errors.count() === 0) return;
    writeToAgent(id, `Preview runtime errors (${errors.count()}):\n${errors.format()}\n\r`);
    errors.clear();
  }

  function onAgentClosed(id) {
    defaultUA.delete(id);
    if (agentId === id) { agentId = null; registry.hideAll(); }
  }

  return {
    setAgent,
    load,
    setDevice,
    sendErrors,
    onAgentNavigated,
    onAgentClosed,
    setBounds: (b) => { bounds = b; apply(); },
    show: () => { visible = true; apply(); },
    hide: () => { visible = false; registry.hideAll(); },
    reload: () => { const w = wc(); if (w) { try { w.reload(); } catch {} restoreParentFocus(); } },
    clearErrors: (id) => { if (typeof id === 'number' && registry.has(id)) registry.errorsFor(id).clear(); },
    destroy: () => { agentId = null; visible = false; defaultUA.clear(); },
  };
}

module.exports = { createPreviewController };
