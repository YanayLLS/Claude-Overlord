// agentId -> WebContentsView lifecycle. The only module that owns Electron view
// objects; makeView/attach/detach/partitionFor are injected so this stays
// testable and so it never has to reach for agent state it does not own.
const { createErrorBuffer } = require('./errors');
const { createActions } = require('./actions');
const { wireErrors, wireNavigation, wireNetworkErrors, unwireNetworkErrors, wireHealth } = require('./view-wiring');
const { createInputRebinder } = require('./input-rebind');
const { isBlankImage, isDarkBackground, BACKGROUND_PROBE } = require('./health');

// A view that is only ever setVisible(false) is laid out at 0x0: window.innerWidth
// is 0, every block-level element measures zero width, and the snapshot skips
// them all. Measured on Electron 33: giving the attached view real bounds and
// making it visible for one synchronous tick establishes a viewport that then
// SURVIVES setVisible(false). These are that viewport — the same 1280x800 the
// preview pane calls its desktop preset.
const DEFAULT_VIEW_WIDTH = 1280;
const DEFAULT_VIEW_HEIGHT = 800;

// Electron asks every attached view, hidden or not, whether a point is a window-drag area, and
// offsets the point only by the view's position. A hidden view left over the window therefore
// lays its page's own `app-region: drag` title bar on top of Overlord: measured on Electron 33, a
// hidden view at 0,0 turned the header's bookmarks into drag area except for a strip along their
// bottom edge. Hidden views sit out here instead; the size, and so the viewport, is untouched.
const PARKED = { x: 100000, y: 100000 };

// Dead views. A hung renderer gets this long to answer again before it is replaced; a page that
// does not answer a one-line probe in PROBE_TIMEOUT_MS is wedged. A view that keeps dying (a page
// that crashes its renderer on load) is given up on after MAX_RECOVERIES in RECOVERY_WINDOW_MS.
const UNRESPONSIVE_GRACE_MS = 5000;
const PROBE_TIMEOUT_MS = 8000;
const MAX_RECOVERIES = 3;
const RECOVERY_WINDOW_MS = 60000;

const defaultPartitionFor = (id) => `persist:overlord-agent-${id}`;
const TIMED_OUT = Symbol('timed out');
const within = (promise, ms) => new Promise((resolve, reject) => {
  const t = setTimeout(() => resolve(TIMED_OUT), ms);
  promise.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
});

function createRegistry({
  makeView, attach, detach, onErrorCount, onNavigated = () => {}, onRecovered = () => {}, onClosed = () => {},
  partitionFor = defaultPartitionFor, captureHost = null,
  unresponsiveGraceMs = UNRESPONSIVE_GRACE_MS, probeTimeoutMs = PROBE_TIMEOUT_MS,
}) {
  // agentId -> { view, errors, actions, partition, shown: bounds|null, lent, dead }
  const entries = new Map();
  // A dev-server URL seen in an agent's output before anything asked for its browser. The view is
  // created (a whole renderer process) only on first show / first browser tool call, and loads this
  // then; the first action waits for that load, so navigate-less snapshot/click see the page.
  const primed = new Map(); // agentId -> url
  const recoveries = new Map(); // agentId -> timestamps of recent recoveries

  const park = (view) => { view.setVisible(false); view.setBounds({ ...view.getBounds(), ...PARKED }); };

  // Put a view where its entry says: in the pane, or parked. A lent view is left alone (parking
  // it would clip it out of its capture); the lend's restore places it once it is back.
  function place(entry) {
    if (entry.lent) return;
    if (entry.shown) { entry.view.setBounds(entry.shown); entry.view.setVisible(true); } else park(entry.view);
    emulate(entry);
  }
  // The agent's chosen layout width (browser_viewport): the page lays out that wide whatever the pane's size.
  // Done with the page's zoom: at zoom z a pane w wide lays the page out w/z wide, so z = pane / chosen width.
  // Not device emulation: enableDeviceEmulation took the whole app down (a native crash, no exit path) three
  // times on 2026-11-13, each within seconds of an agent's browser_viewport call.
  // ponytail: height is not emulated, the page keeps the pane's height (scaled); add it back only with a safe API.
  function emulate(entry) {
    const vp = entry.viewport, wc = entry.view.webContents;
    const pane = entry.shown || { width: DEFAULT_VIEW_WIDTH };
    const zoom = vp ? Math.max(0.25, Math.min(5, pane.width / vp.width)) : 1;
    entry.scale = zoom;
    try { if (!wc.isDestroyed() && wc.getZoomFactor() !== zoom) wc.setZoomFactor(zoom); } catch {}
  }
  const rezoom = (entry) => { if (entry && entry.viewport) emulate(entry); };
  function setViewport(id, width, height) {
    ensure(id);
    const entry = entries.get(id), w = Math.round(+width || 0), h = Math.round(+height || 0);
    entry.viewport = w > 0 ? { width: Math.max(320, Math.min(3840, w)), height: h > 0 ? Math.max(240, Math.min(2160, h)) : 0 } : null;
    emulate(entry);
    return entry.viewport;
  }

  // Order is load-bearing: bounds and visibility only take effect once the view
  // is attached to a content view, and the show/hide pair must stay in one tick
  // so no frame is ever presented to the user. The visible tick has to happen
  // over the window: a view made visible out at PARKED gets a 0x0 viewport.
  function establishViewport(view) {
    attach(view);
    view.setBounds({ x: 0, y: 0, width: DEFAULT_VIEW_WIDTH, height: DEFAULT_VIEW_HEIGHT });
    view.setVisible(true);
    park(view);
  }

  // A hidden view has no compositor surface, so nothing can be captured from it. For the
  // capture it is lent to the capture host's invisible window at its own size (no relayout),
  // then re-attached here and put back where it belongs — including in the pane, if the pane
  // asked for it meanwhile. A view on screen in the pane is captured in place.
  function capturable(entry, fn) {
    const recordBlank = async () => { const img = await fn(); entry.lastBlank = isBlankImage(img); return img; };
    if (entry.shown || entry.lent || !captureHost) return recordBlank();
    const b = entry.view.getBounds() || {};
    const size = b.width > 0 && b.height > 0 ? { width: b.width, height: b.height } : { width: DEFAULT_VIEW_WIDTH, height: DEFAULT_VIEW_HEIGHT };
    entry.lent = true;
    try { detach(entry.view); } catch {}
    return captureHost.run(entry.view, size, recordBlank, () => {
      entry.lent = false;
      if (entry.dead) return;
      try { attach(entry.view); place(entry); } catch {}
    });
  }

  function ensure(id) {
    const existing = entries.get(id);
    if (existing) return existing.view;
    const partition = partitionFor(id);
    const view = makeView(partition);
    // One gate, two consumers: while the input re-bind load runs, neither the
    // error buffer nor the pane may see it as a second navigation.
    const rebinder = createInputRebinder();
    const errors = createErrorBuffer((count, last) => onErrorCount(id, count, last), rebinder.isSuppressed);
    wireErrors(view.webContents, errors);
    // Any load, even a suppressed re-bind one, can yank keyboard focus into the view.
    const wcId = view.webContents.id;
    const entry = { view, wcId, errors: null, actions: null, partition, lastNavAt: 0, shown: null, lent: false, dead: false, lastBlank: false, hungTimer: null };
    const current = () => entries.get(id) === entry;
    wireNavigation(id, view.webContents, onNavigated, rebinder.isSuppressed, () => { entry.lastNavAt = Date.now(); rezoom(entry); });
    wireNetworkErrors(partition, errors, wcId);
    wireHealth(view.webContents, {
      onGone: (reason) => { if (current()) setTimeout(() => { if (current()) recover(id, `renderer ${reason}`); }, 0); },
      onUnresponsive: () => {
        if (!current() || entry.hungTimer) return;
        entry.hungTimer = setTimeout(() => { entry.hungTimer = null; if (current()) recover(id, 'renderer unresponsive'); }, unresponsiveGraceMs);
      },
      onResponsive: () => { clearTimeout(entry.hungTimer); entry.hungTimer = null; },
    });
    const raw = createActions({
      getWebContents: () => { const e = entries.get(id); return e ? e.view.webContents : null; },
      errors,
      rebindInput: rebinder.rebind,
      withCapturable: (fn) => capturable(entry, fn),
      inputScale: () => entry.scale || 1, // a scaled-down layout (browser_viewport) takes input in drawn pixels
    });
    const settle = async () => { if (entry.priming) { await entry.priming.catch(() => {}); entry.priming = null; } };
    const actions = {};
    for (const [k, f] of Object.entries(raw)) actions[k] = async (...a) => { await settle(); return f(...a); };
    // An all-black frame of a page that is not black is a dead view: replace it and capture the new one.
    actions.screenshot = async () => {
      await settle();
      entry.lastBlank = false;
      const png = await raw.screenshot();
      if (entry.lastBlank && current() && (await looksDead(entry)) && recover(id, 'blank frame')) return entries.get(id).actions.screenshot();
      return png;
    };
    actions.viewport = async (width, height) => {
      const vp = setViewport(id, width, height);
      return vp ? `The page now lays out ${vp.width}px wide${vp.height ? ` x ${vp.height}px` : ''} (scaled to fit the pane when it is narrower); screenshots show that layout.` : 'Back to the pane\'s own size.';
    };
    // Done with the page: the view goes away and the pane beside the chat closes (the next browser_navigate reopens it).
    actions.close = async () => { setImmediate(() => { destroy(id); onClosed(id); }); return 'Closed the browser pane.'; };
    entry.errors = errors; entry.actions = actions;
    entries.set(id, entry);
    establishViewport(view);
    const url = primed.get(id);
    if (url) { primed.delete(id); entry.priming = raw.navigate(url); entry.priming.catch(() => {}); }
    return view;
  }

  // True when the page does not answer a probe in time, or answers that it is not dark.
  async function looksDead(entry) {
    let bg;
    try { bg = await within(entry.view.webContents.executeJavaScript(BACKGROUND_PROBE, true), probeTimeoutMs); } catch { return false; }
    return bg === TIMED_OUT || !isDarkBackground(bg);
  }

  // Replace a dead view with a fresh one on the same partition (its cookies and logins live on
  // disk under it), reload the page it was on, and put it back where it was. Returns false when
  // the agent has no browser, or its view keeps dying and has been given up on.
  function recover(id, reason) {
    const old = entries.get(id);
    if (!old) return false;
    const now = Date.now();
    const recent = (recoveries.get(id) || []).filter((t) => now - t < RECOVERY_WINDOW_MS);
    if (recent.length >= MAX_RECOVERIES) { // reported once; tried again once the window has passed
      recoveries.set(id, recent);
      if (!old.givenUp) { old.givenUp = true; try { onRecovered(id, reason, false, ''); } catch {} }
      return false;
    }
    recoveries.set(id, [...recent, now]);
    let url = '';
    try { url = old.view.webContents.getURL(); } catch {}
    const shown = old.shown;
    entries.delete(id);
    old.dead = true;
    clearTimeout(old.hungTimer);
    try { detach(old.view); } catch {}
    try { old.view.webContents.forcefullyCrashRenderer(); } catch {} // a hung renderer would otherwise live on
    try { old.view.webContents.close(); } catch {}
    unwireNetworkErrors(old.partition, old.wcId);
    if (/^https?:\/\//i.test(url)) primed.set(id, url);
    ensure(id);
    if (shown) show(id, shown);
    try { onRecovered(id, reason, true, url); } catch {}
    return true;
  }

  // Is this agent's view alive and painting? Replaces it when it is not.
  // 'none' (no browser), 'ok', 'recovered' or 'dead' (given up on).
  async function checkHealth(id) {
    const entry = entries.get(id);
    if (!entry) return 'none';
    const outcome = (reason) => (recover(id, reason) ? 'recovered' : 'dead');
    let crashed = false;
    try { crashed = entry.view.webContents.isCrashed(); } catch {}
    if (crashed) return outcome('renderer crashed');
    let bg;
    try { bg = await within(entry.view.webContents.executeJavaScript(BACKGROUND_PROBE, true), probeTimeoutMs); } catch { return 'ok'; } // mid-navigation: no verdict
    if (entries.get(id) !== entry) return 'ok';
    if (bg === TIMED_OUT) return outcome('renderer not answering');
    try { await entry.actions.frame(); } catch { return 'ok'; } // no frame (window minimised): no verdict
    if (entries.get(id) !== entry) return 'ok';
    return entry.lastBlank && !isDarkBackground(bg) ? outcome('blank frame') : 'ok';
  }

  // Remember (or, if the browser already exists, load) the agent's dev-server URL.
  function prime(id, url) {
    const e = entries.get(id);
    if (!e) return primed.set(id, url);
    e.priming = e.actions.navigate(url); e.priming.catch(() => {}); // the next action waits for this load too
  }

  function show(id, b) {
    hideAll();
    ensure(id);
    const entry = entries.get(id);
    const round = (n) => Math.max(0, Math.round(n || 0));
    entry.shown = { x: round(b.x), y: round(b.y), width: round(b.width), height: round(b.height) };
    place(entry);
  }

  function hideAll() {
    for (const entry of entries.values()) { entry.shown = null; try { place(entry); } catch {} }
  }

  function destroy(id) {
    primed.delete(id);
    recoveries.delete(id);
    const entry = entries.get(id);
    if (!entry) return;
    entries.delete(id); // first: a renderer-gone event from the close below must not bring it back
    entry.dead = true;
    clearTimeout(entry.hungTimer);
    try { detach(entry.view); } catch {}
    try { entry.view.webContents.close(); } catch {}
    unwireNetworkErrors(entry.partition, entry.wcId);
  }

  const has = (id) => entries.has(id);
  const errorsFor = (id) => { ensure(id); return entries.get(id).errors; };
  const actionsFor = (id) => { try { ensure(id); return entries.get(id).actions; } catch { return null; } };
  const destroyAll = () => { for (const id of [...entries.keys()]) destroy(id); };
  // True when some agent view loaded within the last `ms` — the moment a view steals focus from the terminal.
  const navigatedWithin = (ms, now = Date.now()) => [...entries.values()].some(e => now - e.lastNavAt < ms);

  return { setViewport, ensure, show, hideAll, has, errorsFor, actionsFor, prime, destroy, destroyAll, navigatedWithin, checkHealth };
}

module.exports = { createRegistry, DEFAULT_VIEW_WIDTH, DEFAULT_VIEW_HEIGHT };
