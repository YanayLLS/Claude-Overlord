// The seven browser actions, against one webContents. Injected, never imported,
// so this module stays testable with a fake webContents.
const { SNAPSHOT_SOURCE, refPointSource } = require('./snapshot-script');

const STALE = 'That ref is stale or missing — call browser_snapshot again to get fresh refs.';

// Measured on Electron 33: a WebContentsView that is not visible produces no
// compositor frames at all. capturePage() rejects with "Current display surface
// not available for capture", and CDP Page.captureScreenshot never resolves.
// withCapturable (the registry's) makes a hidden view paint for the capture by
// lending it to an invisible window (browser/capture-host.js). Until its first
// frame lands capturePage still rejects, so a rejection and an empty image are
// both retried up to a bounded deadline. It always settles.
const CAPTURE_TIMEOUT_MS = 5000;
const CAPTURE_RETRY_MS = 100;
const NO_SCREENSHOT = 'Screenshot unavailable: no frame could be captured from this agent\'s browser. Use browser_snapshot to read the page — it works without a frame.';

function withTimeout(promise, ms) {
  let timer;
  const limit = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
}

function createActions({ getWebContents, errors, captureTimeoutMs = CAPTURE_TIMEOUT_MS, rebindInput = async () => {}, withCapturable = (fn) => fn(), inputScale = () => 1 }) {
  function wc() {
    const w = getWebContents();
    if (!w) throw new Error('This agent has no browser available.');
    return w;
  }

  async function navigate(url) {
    if (!/^https?:\/\//i.test(url)) throw new Error(`Only http(s) URLs are supported, got: ${url}`);
    const w = wc();
    errors.clear();
    await w.loadURL(url);
    // A view's first navigation leaves input routed at a discarded widget, so
    // clicks and keystrokes are silently dropped. rebindInput is a one-shot
    // second load that fixes it; awaiting it here is what makes
    // navigate -> snapshot -> click work on an agent's very first page.
    await rebindInput(w);
    return `Loaded ${w.getURL()}`;
  }

  async function snapshot() {
    const s = await wc().executeJavaScript(SNAPSHOT_SOURCE, true);
    const text = s.text ? `\n\n--- visible text ---\n${s.text}` : '';
    return `${s.title}\n${s.url}\n\n${s.tree}${text}`;
  }

  async function evaluate(js) {
    return JSON.stringify(await wc().executeJavaScript(js, true));
  }

  async function consoleErrors() {
    return errors.count() === 0 ? 'No errors.' : `${errors.count()} error(s):\n${errors.format()}`;
  }

  // A view that has only just been shown (or lent) has not composited a frame
  // yet: capturePage rejects, then resolves empty, then returns the page.
  async function capture(w, deadline) {
    for (;;) {
      let image = null;
      let failure = null;
      try { image = await withTimeout(w.capturePage(), Math.max(1, deadline - Date.now())); } catch (e) { failure = e; }
      if (image && !image.isEmpty()) return image;
      if (failure && /timed out/.test(failure.message)) throw failure;
      if (Date.now() + CAPTURE_RETRY_MS >= deadline) throw failure || new Error('capturePage returned an empty image');
      await new Promise((r) => setTimeout(r, CAPTURE_RETRY_MS));
    }
  }

  // The page's current frame as a NativeImage, painted even when the view is hidden.
  async function frame() {
    const w = wc();
    return withCapturable(() => capture(w, Date.now() + captureTimeoutMs));
  }

  // Always settles: either a PNG or an explanation. It must never leave the
  // agent's tool call hanging.
  async function screenshot() {
    wc();
    try {
      return (await frame()).toPNG().toString('base64');
    } catch (e) {
      throw new Error(`${NO_SCREENSHOT} (${(e && e.message) || e})`);
    }
  }

  async function pointFor(ref) {
    const point = await wc().executeJavaScript(refPointSource(ref), true);
    if (!point) throw new Error(STALE);
    return point;
  }

  // What you watch in the pane: a cursor glides to the target, then a ripple marks the click (a ring marks a field being
  // typed into). Drawn in the page as a pointer-events:none overlay; a failure to draw never blocks the action.
  const CURSOR_MS = 320;
  const cursorSource = (x, y, ring) => `(() => { const id = '__ovl_cursor'; let c = document.getElementById(id);
    if (!c) { c = document.createElement('div'); c.id = id; c.style.cssText = 'position:fixed;left:0;top:0;width:22px;height:22px;z-index:2147483647;pointer-events:none;transition:transform ${CURSOR_MS}ms cubic-bezier(.2,.8,.2,1),opacity .3s;transform:translate(' + (innerWidth / 2) + 'px,' + (innerHeight / 2) + 'px)';
      c.innerHTML = '<svg width="22" height="22" viewBox="0 0 24 24"><path d="M4 3l7 17 2.5-7L21 10.5z" fill="#d97757" stroke="#fff" stroke-width="1.5" stroke-linejoin="round"/></svg>'; document.documentElement.appendChild(c); c.getBoundingClientRect(); }
    c.style.opacity = '1'; c.style.transform = 'translate(${x - 4}px,${y - 3}px)'; clearTimeout(c._t); c._t = setTimeout(() => { c.style.opacity = '0'; }, 2500);
    setTimeout(() => { const d = document.createElement('div'); d.style.cssText = 'position:fixed;left:${x}px;top:${y}px;width:10px;height:10px;margin:-5px 0 0 -5px;border-radius:50%;z-index:2147483646;pointer-events:none;border:2px solid #d97757;transition:transform .45s ease-out,opacity .45s ease-out'; document.documentElement.appendChild(d); requestAnimationFrame(() => { d.style.transform = 'scale(${ring ? 2.2 : 4})'; d.style.opacity = '0'; }); setTimeout(() => d.remove(), 500); }, ${CURSOR_MS}); return true; })()`;
  async function showCursor(w, { x, y }, ring) {
    try { await w.executeJavaScript(cursorSource(Math.round(x), Math.round(y), ring), true); await new Promise((res) => setTimeout(res, CURSOR_MS + 40)); } catch {}
  }

  async function clickAt(w, { x, y }) {
    const k = inputScale(), base = { x: Math.round(x * k), y: Math.round(y * k), button: 'left', clickCount: 1 };
    w.sendInputEvent({ type: 'mouseDown', ...base });
    w.sendInputEvent({ type: 'mouseUp', ...base });
  }

  async function click(ref) {
    const w = wc();
    const pt = await pointFor(ref);
    await showCursor(w, pt, false);
    await clickAt(w, pt);
    return `Clicked ${ref}`;
  }

  async function type(ref, text, submit) {
    const w = wc();
    const pt = await pointFor(ref);
    await showCursor(w, pt, true);
    await clickAt(w, pt);
    for (const ch of String(text)) w.sendInputEvent({ type: 'char', keyCode: ch });
    if (submit) w.sendInputEvent({ type: 'char', keyCode: 'Return' });
    return `Typed into ${ref}${submit ? ' and submitted' : ''}`;
  }

  return { navigate, snapshot, screenshot, frame, click, type, consoleErrors, evaluate };
}

module.exports = { createActions, CAPTURE_TIMEOUT_MS };
