// Pure helper for keeping the pty's size in step with the xterm's. Shared by the
// renderer (index.html) and the node self-check. No DOM, no xterm — just numbers.

// Whether the pty still needs to be told about `next`.
// `last` is the size already sent (null before the first send), `next` the size
// the xterm was just fit to. Degenerate measurements — a closed panel, an
// unlaid-out container — are never sent: resizing the pty to 0 columns makes the
// agent redraw its whole frame for a width that does not exist.
function shouldSendResize(last, next) {
  if (!next) return false;
  if (!(next.cols > 0) || !(next.rows > 0)) return false;
  if (!last) return true;
  return last.cols !== next.cols || last.rows !== next.rows;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { shouldSendResize };
}
