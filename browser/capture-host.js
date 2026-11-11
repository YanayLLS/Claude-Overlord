// Somewhere a hidden agent view can paint for a screenshot without being seen.
//
// Measured on Electron 33.4: a WebContentsView that is setVisible(false), or visible
// but clipped out of its window (parked off at x/y 100000), has no compositor surface.
// capturePage rejects "Current display surface not available", capturePage's
// stayHidden/stayAwake change nothing, CDP Page.captureScreenshot never answers and
// beginFrameSubscription gets no frames. A view only paints while it is visible inside
// a shown, unoccluded window. So for the capture the view is lent to its own window:
// fully transparent (opacity 0), click-through, unfocusable, off the taskbar, and
// always on top so Windows' occlusion tracking never stops it painting. Nothing of it
// reaches the screen, and the main window and preview pane are never touched.
const CAPTURE_WINDOW_OPTIONS = {
  show: false, frame: false, opacity: 0, width: 1, height: 1,
  skipTaskbar: true, focusable: false, resizable: false, movable: false,
  minimizable: false, maximizable: false, alwaysOnTop: true, hasShadow: false,
  webPreferences: { backgroundThrottling: false },
};

// On a display (an off-screen window counts as occluded and stops painting).
function makeCaptureWindow({ BrowserWindow, screen }) {
  const { x, y } = screen.getPrimaryDisplay().workArea;
  const win = new BrowserWindow({ ...CAPTURE_WINDOW_OPTIONS, x, y });
  win.setIgnoreMouseEvents(true);
  return win;
}

function createCaptureHost({ makeWindow }) {
  let win = null;
  let queue = Promise.resolve();
  const host = () => { if (!win || win.isDestroyed()) win = makeWindow(); return win; };

  // Lends `view` to the capture window, visible at `size`, for as long as fn runs, then
  // takes it back out and calls restore() (which re-homes it). One lend at a time.
  function run(view, size, fn, restore) {
    const job = queue.then(async () => {
      const w = host();
      try {
        w.showInactive();
        w.contentView.addChildView(view);
        view.setBounds({ x: 0, y: 0, width: size.width, height: size.height });
        view.setVisible(true);
        return await fn();
      } finally {
        try { view.setVisible(false); } catch {}
        try { w.contentView.removeChildView(view); } catch {}
        try { w.hide(); } catch {}
        restore();
      }
    });
    queue = job.catch(() => {});
    return job;
  }

  function destroy() { if (win && !win.isDestroyed()) { try { win.destroy(); } catch {} } win = null; }

  return { run, destroy };
}

module.exports = { createCaptureHost, makeCaptureWindow, CAPTURE_WINDOW_OPTIONS };
