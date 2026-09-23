// xterm 5.5 sends a keyCode-229 key (remote-desktop input, some keyboards) from a setTimeout
// that diffs its hidden textarea. A normal key typed in that gap goes out first, so
// "this word" arrives as "thi sword". Fix: send the 229 key's text the moment its input
// event lands, and put the textarea back so xterm's deferred diff finds nothing to send.
function makeKey229Fix(terminal, textarea) {
  let before = null; // textarea value at the 229 keydown; null = not ours
  return {
    keydown(e) { before = e.keyCode === 229 && !e.isComposing ? textarea.value : null; },
    input(e) { // capture-phase listener on the terminal element
      const b = before; before = null;
      if (b === null || e.inputType !== 'insertText' || !e.data || e.isComposing) return;
      e.stopImmediatePropagation();
      terminal.input(e.data, true);
      textarea.value = b;
    },
  };
}

if (typeof module !== 'undefined' && module.exports) module.exports = { makeKey229Fix };
