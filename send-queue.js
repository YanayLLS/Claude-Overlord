// Handing messages to an agent's CLI, one at a time per agent, each submitted before the next starts: pastes that
// overlap get merged or dropped by the CLI (a long text still being taken in lost to an image paste behind it).
// Text left in the CLI's box is erased first, inside the same queue, so a message on its way is never taken for it.
// cancel(id) is Esc: what's still waiting for that agent is dropped, one being pasted is never submitted, and the Esc
// itself reaches the CLI only after the paste in progress is fully written (else it lands inside it as text).
// Self-check: send-queue.test.js

const pause = (ms) => new Promise(r => setTimeout(r, ms));
// The CLI collapses a long paste into "[Pasted text #N]" a moment after it ends: the next paste or Enter waits for that.
const pasteSettleMs = (len) => 150 + Math.ceil(len / 1024) * 12 + (len > 800 ? 250 : 0);
const bracketed = (s) => '\x1b[200~' + s + '\x1b[201~';

// getTerm(id) → { write(s) } or null: the agent's live CLI; isReady(id): it can take a message (at its prompt, no dialog);
// writeChunked(term, s) writes a long string in pieces (may return a promise that resolves when all are written);
// isImage(path) → bool; wait(ms) is pause by default (a test passes its own).
// No CLI right now (still loading, a crash being auto-resumed, Overlord restarting): a message waits up to waitMs for one,
// then opts.onFail. The CLI swapped mid-paste (it died, a new one came): the whole message goes again into the new one.
// opts.still() false once a CLI is ready: not sent (it reached the transcript meanwhile). opts.onSent: Enter written.
function makeSender({ getTerm, writeChunked = (t, s) => t.write(s), isImage = () => true, wait = pause, log = () => {}, isReady = () => true, pollMs = 500, waitMs = 10 * 60e3 }) {
  const chains = new Map();  // agent id → its last send
  const gens = new Map();    // agent id → Esc count: a send started under an older one stops
  const writing = new Map(); // agent id → the paste being written right now
  const gen = (id) => gens.get(id) || 0;
  const inOrder = (id, fn) => {
    const g = gen(id);
    const p = (chains.get(id) || Promise.resolve()).then(() => (gen(id) === g ? fn(() => gen(id) !== g) : undefined)).catch((e) => log(`send to agent ${id} failed: ${e && e.message}`));
    chains.set(id, p); return p;
  };
  const put = async (id, t, s) => { const w = Promise.resolve(writeChunked(t, s)); writing.set(id, w); try { await w; } finally { if (writing.get(id) === w) writing.delete(id); } };
  const erase = async (t, n) => { if (n > 0) { t.write('\x05' + '\x7f'.repeat(Math.min(n, 20000))); await wait(120); } }; // Ctrl+E, then Backspace: safe mid-turn
  // onSubmit runs as Enter goes in, never for a cancelled message (a /clear or /resume is acted on only once really sent).
  const submit = async (t, onSubmit) => { if (onSubmit) onSubmit(); t.write('\r'); await wait(250); };
  const ready = async (id, cancelled, opts = {}) => { for (let w = 0; w <= waitMs && !cancelled(); w += pollMs) { const t = getTerm(id); if (t && isReady(id, opts)) return t; await wait(pollMs); } return null; };
  // One message, start to Enter, into one CLI; again from the start in a new CLI if that one went away meanwhile.
  const deliver = (id, opts, body) => inOrder(id, async (cancelled) => {
    for (let tries = 0; tries < 4; tries++) {
      const t = await ready(id, cancelled, opts);
      if (cancelled()) return;
      if (!t) break;
      if (opts.still && !opts.still()) return;
      let ok = false; try { ok = await body(t, cancelled, tries); } catch (e) { log(`send to agent ${id} failed: ${e && e.message}`); }
      if (cancelled()) return;
      if (ok) { if (opts.onSent) opts.onSent(); return; } // Enter went in (it dying right after is main's transcript check)
      await wait(pollMs);
    }
    if (!cancelled() && opts.onFail) opts.onFail();
  });
  return {
    // Plain text: one paste, then Enter.
    prompt: (id, text, eraseN = 0, onSubmit = null, opts = {}) => deliver(id, opts, async (t, cancelled, tries) => {
      await erase(t, tries ? 0 : eraseN); // a new CLI's box is empty
      if (cancelled()) return false; // Esc while the leftover was being erased: nothing of it goes in
      const s = bracketed(String(text).replace(/\r\n?/g, '\n'));
      await put(id, t, s); await wait(pasteSettleMs(s.length));
      if (cancelled() || getTerm(id) !== t) return false; // Esc while it was going in: the CLI's own Esc handles what's in its box
      await submit(t, onSubmit); return true;
    }),
    // Text and images in the order written ("compare [Image #1] with [Image #2]"), each paste settled before the next,
    // then Enter.
    parts: (id, parts, eraseN = 0, opts = {}) => deliver(id, opts, async (t, cancelled, tries) => {
      await erase(t, tries ? 0 : eraseN);
      for (const p of parts.slice(0, 60)) {
        if (cancelled() || getTerm(id) !== t) return false;
        if (typeof p.image === 'string' && isImage(p.image)) { await put(id, t, bracketed(p.image.replace(/\\/g, '/'))); await wait(400); }
        else if (typeof p.text === 'string' && p.text) { const s = bracketed(p.text.replace(/\r\n?/g, '\n').slice(0, 200000)); await put(id, t, s); await wait(pasteSettleMs(s.length)); }
      }
      if (cancelled() || getTerm(id) !== t) return false;
      await submit(t); return true;
    }),
    // Just the leftover, in turn with the sends (Esc took a message back).
    erase: (id, n) => inOrder(id, async () => { const t = getTerm(id); if (t) await erase(t, n); }),
    // Esc: stop this agent's sends, then the Esc itself once no paste is half-written.
    // onEsc runs once the Esc is really written (a long paste can hold it back a second or more).
    cancel: (id, esc = true, onEsc = null) => {
      gens.set(id, gen(id) + 1);
      if (esc) Promise.resolve(writing.get(id)).then(() => { const t = getTerm(id); if (t) t.write('\x1b'); if (onEsc) onEsc(); }).catch(() => {});
    },
  };
}

module.exports = { makeSender, pasteSettleMs };
