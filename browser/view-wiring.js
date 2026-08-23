// Event wiring for one agent's WebContentsView. Split out of registry.js so the
// registry stays a lifecycle module and both stay well under the size limit.
// Knows nothing about the registry's Map — every dependency is passed in.
const LEVELS = ['debug', 'info', 'warning', 'error'];

// Electron 33 emits console-message as (event, level, message, line, source);
// older/newer shapes pass a single details object. Accept both.
function normalizeConsole(args) {
  if (args.length >= 4) {
    const [, level, message, line, source] = args;
    return { level: typeof level === 'string' ? level : LEVELS[level], message, line, source };
  }
  const e = args[0] || {};
  return { level: e.level, message: e.message, line: e.lineNumber, source: e.sourceId };
}

function wireErrors(webContents, errors) {
  webContents.on('console-message', (...args) => {
    const { level, message, line, source } = normalizeConsole(args);
    if (level !== 'warning' && level !== 'error') return;
    errors.push({ kind: 'console', level, message: String(message || '').slice(0, 500), source: source || '', line: line || 0 });
  });
  webContents.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
    if (!isMainFrame || code === -3) return;
    errors.push({ kind: 'load', level: 'error', message: `Failed to load ${url}: ${desc} (${code})`, source: url, line: 0 });
  });
}

// Any navigation — full load, history nav, or in-page (hash/pushState) nav —
// must notify the presenter: it repaints the URL bar and, on Windows,
// restores keyboard focus to the parent window so its buttons stay clickable.
function wireNavigation(id, webContents, onNavigated, isSuppressed = () => false) {
  const notify = () => {
    if (isSuppressed()) return; // internal input re-bind load, not an agent navigation
    try { onNavigated(id, webContents.getURL()); } catch {}
  };
  webContents.on('did-finish-load', notify);
  webContents.on('did-navigate', notify);
  webContents.on('did-navigate-in-page', notify);
}

// Network failures arrive on the session, not the webContents. Each agent has
// its own partition, so the hook is installed per agent. Guarded because the
// unit tests run without Electron.
function wireNetworkErrors(partition, errors) {
  try {
    require('electron').session.fromPartition(partition)
      .webRequest.onErrorOccurred({ urls: ['<all_urls>'] }, (d) => {
        if (!d.error || d.error === 'net::ERR_ABORTED') return;
        errors.push({ kind: 'network', level: 'error', message: `${d.error} ${d.url}`, source: d.url, line: 0 });
      });
  } catch {}
}

// Sessions outlive the WebContents they're paired with, so wireNetworkErrors'
// listener has to be unregistered explicitly on destroy — otherwise it keeps
// firing into a dead errors buffer for the rest of the app's life. Passing
// null is Electron's way of clearing a webRequest listener.
function unwireNetworkErrors(partition) {
  try {
    require('electron').session.fromPartition(partition).webRequest.onErrorOccurred(null);
  } catch {}
}

module.exports = { normalizeConsole, wireErrors, wireNavigation, wireNetworkErrors, unwireNetworkErrors };
