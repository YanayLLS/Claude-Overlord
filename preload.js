const { contextBridge, ipcRenderer, webFrame } = require('electron');
contextBridge.exposeInMainWorld('api', {
  send: (msg) => ipcRenderer.send('cmd', msg),
  on: (cb) => ipcRenderer.on('msg', (_e, data) => cb(data)),
  onMainLog: (cb) => ipcRenderer.on('main-log', (_e, msg) => cb(msg)),
  setZoom: (factor) => webFrame.setZoomFactor(factor),
});
