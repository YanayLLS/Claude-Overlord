// UI screenshots of the real index.html with made-up state, for checking a UI change without the app.
//   npx electron scripts/shot/run.js <scenario.js> <outDir> [width] [height]
// Safe on a workstation in use: the real main.js never starts (no agents, Claude, ptys, ports or state of
// yours are touched), the window is offscreen (nothing appears on screen), it runs at low priority, Electron's
// error dialogs are silenced, its profile is a temp folder, and it exits on its own (90 s cap). One at a time.
//
// A scenario exports async ({ inject, js, shot, wait, onCmd }) => {}:
//   inject(msg)      feed the page a message as if main had sent it (agentCreated, status, settings, ...)
//   js(code)         evaluate in the page, returns the result
//   shot(name)       save <outDir>/<name>.png
//   wait(ms)         let renders settle
//   onCmd(fn)        see what the page sends to main (fn(msg)); nothing is answered unless fn does: fn(msg, reply)
require('os').setPriority(0, require('os').constants.priority.PRIORITY_LOW);
const path = require('path'), fs = require('fs'), os = require('os');
const { app, BrowserWindow, ipcMain, dialog } = require('electron');

const [scenarioArg, outArg, wArg, hArg] = process.argv.slice(2).filter(a => !a.startsWith('--'));
const die = (m) => { console.log('ERR', m); app.exit(1); };
dialog.showErrorBox = (t, c) => die(`${t} ${String(c).slice(0, 600)}`);
process.on('uncaughtException', (e) => die(e && e.stack));
process.on('unhandledRejection', (e) => die(e && e.stack));
setTimeout(() => die('timeout (90 s)'), 90000);
if (!scenarioArg || !outArg) die('usage: electron scripts/shot/run.js <scenario.js> <outDir> [width] [height]');

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'overlord-shot-'))); // its own localStorage, not the app's
app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const outDir = path.resolve(outArg); fs.mkdirSync(outDir, { recursive: true });
  const win = new BrowserWindow({ show: false, width: +wArg || 1280, height: +hArg || 820, webPreferences: { offscreen: true, preload: path.join(__dirname, 'stub-preload.js'), contextIsolation: true } });
  win.webContents.on('console-message', (_e, level, msg) => { if (level >= 2 && !/Security|Autofill/.test(msg)) console.log('page:', msg.slice(0, 300)); });
  const cmdFns = [];
  ipcMain.on('cmd', (_e, m) => { for (const fn of cmdFns) fn(m, (reply) => win.webContents.send('msg', reply)); });
  await win.loadFile(path.join(__dirname, '..', '..', 'index.html'));
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  await wait(1200);
  const js = (code) => win.webContents.executeJavaScript(code);
  const api = {
    wait, js,
    inject: (msg) => js(`__injectMainMessage(${JSON.stringify(msg)}); true`),
    shot: async (name) => { await wait(250); const f = path.join(outDir, name + '.png'); fs.writeFileSync(f, (await win.webContents.capturePage()).toPNG()); console.log('shot', f); },
    onCmd: (fn) => cmdFns.push(fn),
  };
  await require(path.resolve(scenarioArg))(api);
  app.exit(0);
});
