const { contextBridge, ipcRenderer, webFrame } = require('electron');
contextBridge.exposeInMainWorld('api', {
  send: (msg) => ipcRenderer.send('cmd', msg),
  on: (cb) => ipcRenderer.on('msg', (_e, data) => cb(data)),
  setZoom: (factor) => webFrame.setZoomFactor(factor),
});
