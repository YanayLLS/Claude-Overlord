// The seven browser actions, against one webContents. Injected, never imported,
// so this module stays testable with a fake webContents.
const { SNAPSHOT_SOURCE, refPointSource } = require('./snapshot-script');

const STALE = 'That ref is stale or missing — call browser_snapshot again to get fresh refs.';

// Measured on Electron 33: a WebContentsView that is not visible produces no
// compositor frames at all. capturePage() rejects with "Current display surface
// not available for capture", and CDP Page.captureScreenshot never resolves —
// it waits for a frame that will never arrive. There is therefore no
// screenshot path for a hidden view; the honest answer is a bounded wait and a
// message that points the agent at the tool that does work headlessly.
const CAPTURE_TIMEOUT_MS = 5000;
const CAPTURE_RETRY_MS = 200;
const NO_SCREENSHOT = 'Screenshot unavailable: this agent\'s browser is running hidden, and a hidden view renders no frames to capture. Use browser_snapshot to read the page — it works headlessly — or open the preview pane for this agent to make screenshots possible.';

function withTimeout(promise, ms) {
  let timer;
  const limit = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
}

function createActions({ getWebContents, errors, captureTimeoutMs = CAPTURE_TIMEOUT_MS, rebindInput = async () => {} }) {
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

  // A view that has only just been shown has not composited a frame yet and
  // capturePage resolves empty for a second or two. A hidden view instead
  // REJECTS outright and never recovers, so only the empty case is retried —
  // that keeps the hidden answer instant and the pane answer reliable.
  async function capture(w, deadline) {
    for (;;) {
      const image = await withTimeout(w.capturePage(), Math.max(1, deadline - Date.now()));
      if (image && !image.isEmpty()) return image;
      if (Date.now() + CAPTURE_RETRY_MS >= deadline) throw new Error('capturePage returned an empty image');
      await new Promise((r) => setTimeout(r, CAPTURE_RETRY_MS));
    }
  }

  // Always settles: either a PNG or an explanation. It must never leave the
  // agent's tool call hanging.
  async function screenshot() {
    const w = wc();
    try {
      return (await capture(w, Date.now() + captureTimeoutMs)).toPNG().toString('base64');
    } catch (e) {
      throw new Error(`${NO_SCREENSHOT} (${(e && e.message) || e})`);
    }
  }

  async function pointFor(ref) {
    const point = await wc().executeJavaScript(refPointSource(ref), true);
    if (!point) throw new Error(STALE);
    return point;
  }

  async function clickAt(w, { x, y }) {
    const base = { x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 };
    w.sendInputEvent({ type: 'mouseDown', ...base });
    w.sendInputEvent({ type: 'mouseUp', ...base });
  }

  async function click(ref) {
    const w = wc();
    await clickAt(w, await pointFor(ref));
    return `Clicked ${ref}`;
  }

  async function type(ref, text, submit) {
    const w = wc();
    await clickAt(w, await pointFor(ref));
    for (const ch of String(text)) w.sendInputEvent({ type: 'char', keyCode: ch });
    if (submit) w.sendInputEvent({ type: 'char', keyCode: 'Return' });
    return `Typed into ${ref}${submit ? ' and submitted' : ''}`;
  }

  return { navigate, snapshot, screenshot, click, type, consoleErrors, evaluate };
}

module.exports = { createActions, CAPTURE_TIMEOUT_MS };
