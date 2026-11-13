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

const LOCAL_HTTP = /^http:\/\/(localhost|127\.0\.0\.1|([\w-]+\.)*lvh\.me)(:\d+)?\//i;

function wireErrors(webContents, errors) {
  webContents.on('console-message', (...args) => {
    const { level, message, line, source } = normalizeConsole(args);
    if (level !== 'warning' && level !== 'error') return;
    errors.push({ kind: 'console', level, message: String(message || '').slice(0, 500), source: source || '', line: line || 0 });
  });
  webContents.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
    if (!isMainFrame || code === -3) return;
    // A local dev server on https (vite --https) answers http with an empty reply: retry the same address on https once.
    if ((code === -324 || code === -100) && LOCAL_HTTP.test(url || '')) { setImmediate(() => { try { webContents.loadURL('https' + url.slice(4)).catch(() => {}); } catch {} }); return; } // not inside the failing navigation's event
    errors.push({ kind: 'load', level: 'error', message: `Failed to load ${url}: ${desc} (${code})`, source: url, line: 0 });
  });
}

// Any navigation — full load, history nav, or in-page (hash/pushState) nav —
// must notify the presenter: it repaints the URL bar and, on Windows,
// restores keyboard focus to the parent window so its buttons stay clickable.
function wireNavigation(id, webContents, onNavigated, isSuppressed = () => false, onLoad = () => {}) {
  const notify = () => {
    onLoad(); // every load counts for focus purposes, suppressed or not
    if (isSuppressed()) return; // internal input re-bind load, not an agent navigation
    try { onNavigated(id, webContents.getURL()); } catch {}
  };
  webContents.on('did-start-loading', onLoad);
  webContents.on('did-finish-load', notify);
  webContents.on('did-navigate', notify);
  webContents.on('did-navigate-in-page', notify);
}

// Network failures arrive on the session, not the webContents, and a session takes one listener per event.
// Agents share a partition (one cookie jar, so a login sticks), so one listener per partition routes each
// failure to the buffer of the view that made the request. Guarded because the unit tests run without Electron.
const netRoutes = new Map(); // partition -> Map(webContentsId -> errors)
function onNetError(routes, d) {
  if (!d.error || d.error === 'net::ERR_ABORTED') return;
  if (d.resourceType === 'mainFrame' && /ERR_EMPTY_RESPONSE|ERR_CONNECTION_CLOSED/.test(d.error) && LOCAL_HTTP.test(d.url)) return; // retried on https, see wireErrors
  const errors = routes.get(d.webContentsId); if (!errors) return;
  errors.push({ kind: 'network', level: 'error', message: `${d.error} ${d.url}`, source: d.url, line: 0 });
}
function wireNetworkErrors(partition, errors, wcId) {
  let routes = netRoutes.get(partition);
  if (!routes) {
    netRoutes.set(partition, routes = new Map());
    try { require('electron').session.fromPartition(partition).webRequest.onErrorOccurred({ urls: ['<all_urls>'] }, (d) => onNetError(routes, d)); } catch {}
  }
  routes.set(wcId, errors);
}

// Sessions outlive their views: a closed view leaves the routes, and the last one out clears the listener
// (passing null is Electron's way), so nothing fires into a dead buffer for the rest of the app's life.
function unwireNetworkErrors(partition, wcId) {
  const routes = netRoutes.get(partition); if (!routes) return;
  routes.delete(wcId);
  if (routes.size) return;
  netRoutes.delete(partition);
  try { require('electron').session.fromPartition(partition).webRequest.onErrorOccurred(null); } catch {}
}

// A renderer that dies (crash, kill, OOM) leaves the view black while its URL bar
// still names the page. clean-exit is our own close. A hung renderer reports
// unresponsive, and responsive again if it comes back.
function wireHealth(webContents, { onGone, onUnresponsive, onResponsive }) {
  webContents.on('render-process-gone', (_e, details) => {
    const reason = (details && details.reason) || 'gone';
    if (reason !== 'clean-exit') onGone(reason);
  });
  webContents.on('unresponsive', onUnresponsive);
  webContents.on('responsive', onResponsive);
}

module.exports = { onNetError, normalizeConsole, wireErrors, wireNavigation, wireNetworkErrors, unwireNetworkErrors, wireHealth };
