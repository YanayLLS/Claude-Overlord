// Pure helpers for the Terminals pane (term-pane.js) and its ovl-start helper. No Electron, no I/O.

// cmd's own quoting: an arg with a space or a shell character goes back in double quotes.
const quoteArg = (a) => (a === '' || /[\s&|<>^()"]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a);

// argv as `start` takes it: ["title", "/D", dir, "/MIN", "cmd", "/k", "npm run dev"]. The title is required
// (node's argv has lost the quotes that tell start a title from a command). Switches optional.
// -> { name, cwd, mode: '/k' | '/c', line } — line is what cmd runs.
function parseStartArgs(argv, defaultCwd) {
  const a = [...argv];
  let cwd = defaultCwd;
  const name = a.shift();
  while (a.length && /^\//.test(a[0])) {
    const sw = a.shift().toUpperCase();
    if (sw === '/D' && a.length) cwd = a.shift();
    else if (sw.startsWith('/D') && sw.length > 2) cwd = sw.slice(2);
  }
  let mode = '/k';
  if (a.length && /^cmd(\.exe)?$/i.test(a[0])) {
    a.shift();
    while (a.length && /^\/[a-z]$/i.test(a[0])) { const s = a.shift().toLowerCase(); if (s === '/c' || s === '/k') { mode = s; break; } }
  }
  const line = a.map(quoteArg).join(' ');
  if (!line) return null;
  return { name: name || line.slice(0, 40), cwd, mode, line };
}

const BUF_MAX = 256 * 1024; // chars of output kept per tab for a reloaded window
const appendBuf = (buf, d) => { const b = buf + d; return b.length > BUF_MAX ? b.slice(-BUF_MAX) : b; };

module.exports = { parseStartArgs, quoteArg, appendBuf, BUF_MAX };
