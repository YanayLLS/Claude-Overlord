const { contextBridge, ipcRenderer, webFrame, webUtils } = require('electron');
contextBridge.exposeInMainWorld('api', {
  send: (msg) => ipcRenderer.send('cmd', msg),
  on: (cb) => ipcRenderer.on('msg', (_e, data) => cb(data)),
  onMainLog: (cb) => ipcRenderer.on('main-log', (_e, msg) => cb(msg)),
  setZoom: (factor) => webFrame.setZoomFactor(factor),
  // Absolute path for a dropped File (File.path is gone in modern Electron)
  getFilePath: (file) => { try { return webUtils.getPathForFile(file); } catch { return null; } },
  version: require('./package.json').version,
});
