// The real preload's surface (preload.js) without the app behind it, for scripts/shot/run.js.
const { contextBridge, ipcRenderer } = require('electron');
const subs = [];
ipcRenderer.on('msg', (_e, d) => { for (const cb of subs) cb(d); });
contextBridge.exposeInMainWorld('__injectMainMessage', (d) => { for (const cb of subs) cb(d); });
contextBridge.exposeInMainWorld('api', { send: (m) => ipcRenderer.send('cmd', m), on: (cb) => subs.push(cb), onMainLog() {}, setZoom() {}, getFilePath() { return null; }, version: 'shot' });
