// Per-agent ring buffer of console, load, and network errors.
// One buffer per agent; the pane and the browser_console MCP tool both read it.
const ERROR_BUFFER_MAX = 50;

function formatEntry(e) {
  const where = e.source ? ` ${e.source}${e.line ? ':' + e.line : ''}` : '';
  return `[${e.kind.toUpperCase()}/${e.level}]${where} — ${e.message}`;
}

// isSuppressed gates the buffer while browser/input-rebind.js performs its
// internal re-bind load. That load re-executes the page and would otherwise
// duplicate every console error the first load already recorded.
function createErrorBuffer(onChange, isSuppressed = () => false) {
  const errors = [];

  function push(entry) {
    if (isSuppressed()) return;
    errors.push({ ...entry, ts: Date.now() });
    if (errors.length > ERROR_BUFFER_MAX) errors.splice(0, errors.length - ERROR_BUFFER_MAX);
    onChange(errors.length, errors[errors.length - 1]);
  }

  function clear() {
    if (errors.length === 0) return;
    errors.length = 0;
    onChange(0, null);
  }

  const list = () => errors.slice();
  const count = () => errors.length;
  const format = () => errors.map(formatEntry).join('\n');

  return { push, clear, list, count, format };
}

module.exports = { createErrorBuffer, ERROR_BUFFER_MAX };
