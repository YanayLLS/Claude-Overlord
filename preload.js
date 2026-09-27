const { contextBridge, ipcRenderer, webFrame, webUtils } = require('electron');
// Every api.on subscriber (the page, the preview pane). Tests feed the page a message as if main had sent it
// through __injectMainMessage; it is bound once here, because binding it inside on() threw on the second
// subscriber and cut the preview pane's start-up short.
const subscribers = [];
contextBridge.exposeInMainWorld('__injectMainMessage', (data) => { for (const cb of subscribers) cb(data); });
contextBridge.exposeInMainWorld('api', {
  send: (msg) => ipcRenderer.send('cmd', msg),
  on: (cb) => { subscribers.push(cb); ipcRenderer.on('msg', (_e, data) => cb(data)); },
  onMainLog: (cb) => ipcRenderer.on('main-log', (_e, msg) => cb(msg)),
  setZoom: (factor) => webFrame.setZoomFactor(factor),
  // Absolute path for a dropped File (File.path is gone in modern Electron)
  getFilePath: (file) => { try { return webUtils.getPathForFile(file); } catch { return null; } },
  version: require('./package.json').version,
});
