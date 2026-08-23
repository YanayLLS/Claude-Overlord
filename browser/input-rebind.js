// Electron 33 leaves a WebContentsView's input routing bound to the widget it
// discards during the about:blank -> http process swap of its FIRST navigation.
// sendInputEvent is then accepted and silently dropped — no mousedown, no
// mouseup and no click reaches the page — while browser_click and browser_type
// still report success. Two of the seven tools were inert on every agent's very
// first page, which is exactly the failure the design calls the most expensive:
// "a silent no-op is the failure mode that wastes the most agent turns, because
// the agent believes it succeeded."
//
// Measured on Electron 33.4.11: only a real second document load re-binds it.
// A bounds nudge, detach/re-attach, hash navigation, zoom change, invalidate(),
// focus(), a preceding mouseMove, a delay between down and up, re-running the
// visibility handshake, attaching after load and waiting 10s were all measured
// NOT to work. See the fix report for the numbers.
//
// The extra load is an internal detail, so this gate suppresses the error
// buffer and the navigation notifications while it runs: one agent navigation
// must still look like exactly one navigation to the pane and to
// browser_console.
const REBIND_TIMEOUT_MS = 5000;

function createInputRebinder({ timeoutMs = REBIND_TIMEOUT_MS } = {}) {
  let suppressed = false;
  let done = false;

  // Bounded: navigate() awaits this, and it must never leave a tool call hanging.
  function settle(w) {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      const finish = () => { clearTimeout(timer); resolve(); };
      w.once('did-finish-load', finish);
      w.once('did-fail-load', finish);
      w.reload();
    });
  }

  // One-shot per view. Marked done up front so a failed re-bind costs at most
  // one extra load — by the agent's second navigation input is bound anyway.
  async function rebind(w) {
    if (done || !w || typeof w.reload !== 'function' || typeof w.once !== 'function') return;
    done = true;
    suppressed = true;
    try { await settle(w); } finally { suppressed = false; }
  }

  return { rebind, isSuppressed: () => suppressed };
}

module.exports = { createInputRebinder, REBIND_TIMEOUT_MS };
