// agentId -> WebContentsView lifecycle. The only module that owns Electron view
// objects; makeView/attach/detach/partitionFor are injected so this stays
// testable and so it never has to reach for agent state it does not own.
const { createErrorBuffer } = require('./errors');
const { createActions } = require('./actions');
const { wireErrors, wireNavigation, wireNetworkErrors, unwireNetworkErrors } = require('./view-wiring');
const { createInputRebinder } = require('./input-rebind');

// A view that is only ever setVisible(false) is laid out at 0x0: window.innerWidth
// is 0, every block-level element measures zero width, and the snapshot skips
// them all. Measured on Electron 33: giving the attached view real bounds and
// making it visible for one synchronous tick establishes a viewport that then
// SURVIVES setVisible(false). These are that viewport — the same 1280x800 the
// preview pane calls its desktop preset.
const DEFAULT_VIEW_WIDTH = 1280;
const DEFAULT_VIEW_HEIGHT = 800;

const defaultPartitionFor = (id) => `persist:overlord-agent-${id}`;

function createRegistry({ makeView, attach, detach, onErrorCount, onNavigated = () => {}, partitionFor = defaultPartitionFor }) {
  const entries = new Map(); // agentId -> { view, errors, actions, partition }

  // Order is load-bearing: bounds and visibility only take effect once the view
  // is attached to a content view, and the show/hide pair must stay in one tick
  // so no frame is ever presented to the user.
  function establishViewport(view) {
    attach(view);
    view.setBounds({ x: 0, y: 0, width: DEFAULT_VIEW_WIDTH, height: DEFAULT_VIEW_HEIGHT });
    view.setVisible(true);
    view.setVisible(false);
  }

  function ensure(id) {
    const existing = entries.get(id);
    if (existing) return existing.view;
    const partition = partitionFor(id);
    const view = makeView(partition);
    // One gate, two consumers: while the input re-bind load runs, neither the
    // error buffer nor the pane may see it as a second navigation.
    const rebinder = createInputRebinder();
    const errors = createErrorBuffer((count, last) => onErrorCount(id, count, last), rebinder.isSuppressed);
    wireErrors(view.webContents, errors);
    wireNavigation(id, view.webContents, onNavigated, rebinder.isSuppressed);
    wireNetworkErrors(partition, errors);
    const actions = createActions({
      getWebContents: () => { const e = entries.get(id); return e ? e.view.webContents : null; },
      errors,
      rebindInput: rebinder.rebind,
    });
    entries.set(id, { view, errors, actions, partition });
    establishViewport(view);
    return view;
  }

  function show(id, b) {
    hideAll();
    const view = ensure(id);
    const round = (n) => Math.max(0, Math.round(n || 0));
    view.setBounds({ x: round(b.x), y: round(b.y), width: round(b.width), height: round(b.height) });
    view.setVisible(true);
  }

  function hideAll() {
    for (const { view } of entries.values()) { try { view.setVisible(false); } catch {} }
  }

  function destroy(id) {
    const entry = entries.get(id);
    if (!entry) return;
    try { detach(entry.view); } catch {}
    try { entry.view.webContents.close(); } catch {}
    unwireNetworkErrors(entry.partition);
    entries.delete(id);
  }

  const has = (id) => entries.has(id);
  const errorsFor = (id) => { ensure(id); return entries.get(id).errors; };
  const actionsFor = (id) => { try { ensure(id); return entries.get(id).actions; } catch { return null; } };
  const destroyAll = () => { for (const id of [...entries.keys()]) destroy(id); };

  return { ensure, show, hideAll, has, errorsFor, actionsFor, destroy, destroyAll };
}

module.exports = { createRegistry, DEFAULT_VIEW_WIDTH, DEFAULT_VIEW_HEIGHT };
