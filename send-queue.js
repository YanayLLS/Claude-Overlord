// Handing messages to an agent's CLI, one at a time per agent, each submitted before the next starts: pastes that
// overlap get merged or dropped by the CLI (a long text still being taken in lost to an image paste behind it).
// Text left in the CLI's box is erased first, inside the same queue, so a message on its way is never taken for it.
// cancel(id) drops what's still waiting for that agent and stops one mid-way (Esc took it back).
// Self-check: send-queue.test.js

const pause = (ms) => new Promise(r => setTimeout(r, ms));
// The CLI collapses a long paste into "[Pasted text #N]" a moment after it ends: the next paste or Enter waits for that.
const pasteSettleMs = (len) => 150 + Math.ceil(len / 1024) * 12 + (len > 800 ? 250 : 0);
const bracketed = (s) => '\x1b[200~' + s + '\x1b[201~';

// getTerm(id) → { write(s) } or null; writeChunked(term, s) writes a long string in pieces; isImage(path) → bool;
// wait(ms) is pause by default (a test passes its own).
function makeSender({ getTerm, writeChunked = (t, s) => t.write(s), isImage = () => true, wait = pause, log = () => {} }) {
  const chains = new Map(); // agent id → its last send
  const gens = new Map();   // agent id → cancel count: a send started under an older one stops
  const gen = (id) => gens.get(id) || 0;
  const inOrder = (id, fn) => {
    const g = gen(id);
    const p = (chains.get(id) || Promise.resolve()).then(() => (gen(id) === g ? fn(() => gen(id) !== g) : undefined)).catch((e) => log(`send to agent ${id} failed: ${e && e.message}`));
    chains.set(id, p); return p;
  };
  const erase = async (t, n) => { if (n > 0) { t.write('\x05' + '\x7f'.repeat(Math.min(n, 20000))); await wait(120); } }; // Ctrl+E, then Backspace: safe mid-turn
  return {
    // Plain text: one paste, then Enter.
    prompt: (id, text, eraseN = 0) => inOrder(id, async (cancelled) => {
      const t = getTerm(id); if (!t) return;
      await erase(t, eraseN);
      const s = bracketed(String(text).replace(/\r\n?/g, '\n'));
      writeChunked(t, s); await wait(pasteSettleMs(s.length));
      if (cancelled()) return; // Esc while it was going in: the CLI's own Esc handles what's in its box
      t.write('\r'); await wait(250);
    }),
    // Text and images in the order written ("compare [Image #1] with [Image #2]"), each paste settled before the next,
    // then Enter.
    parts: (id, parts, eraseN = 0) => inOrder(id, async (cancelled) => {
      const t = getTerm(id); if (!t) return;
      await erase(t, eraseN);
      for (const p of parts.slice(0, 60)) {
        if (cancelled()) return;
        if (typeof p.image === 'string' && isImage(p.image)) { t.write(bracketed(p.image.replace(/\\/g, '/'))); await wait(400); }
        else if (typeof p.text === 'string' && p.text) { const s = bracketed(p.text.replace(/\r\n?/g, '\n').slice(0, 200000)); writeChunked(t, s); await wait(pasteSettleMs(s.length)); }
      }
      if (cancelled()) return;
      t.write('\r'); await wait(250);
    }),
    // Just the leftover, in turn with the sends (Esc took a message back).
    erase: (id, n) => inOrder(id, async () => { const t = getTerm(id); if (t) await erase(t, n); }),
    cancel: (id) => gens.set(id, gen(id) + 1),
  };
}

module.exports = { makeSender, pasteSettleMs };
