// Main-process side of markdown documents: reads the files the OS (or the page) asks to open,
// watches them so an agent rewriting a plan shows up live, remembers which are open across
// restarts, and registers Overlord as a .md viewer in the per-user registry on Windows.
// Renderer contract: receives docOpen / docClose / docShown / docPick / docReveal / docOpenWith /
// docAssociate; sends { type: 'docOpen' | 'docChange' | 'docGone' | 'docAssociated' }.
const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');
const { MD_RE, withDoc, withoutDoc } = require('./docs-core');

const WATCH_DEBOUNCE_MS = 120; // editors write in bursts (truncate, write, rename): wait for the last
const PROGID = 'Overlord.Markdown';

module.exports = function createDocs({ send, settings, saveState, log = () => {}, focusWindow = () => {}, execPath, appPath, isPackaged, showOpenDialog, showItemInFolder, openPath, openExternal, notesDir = '', platform = process.platform, execFile = childProcess.execFile }) {
  const open = new Map();   // abs path -> { mtime, size }
  const dirs = new Map();   // dir -> { watcher, files: Set<abs path>, timers: Map<abs path, timer> }
  const docs = () => (Array.isArray(settings.docs) ? settings.docs : (settings.docs = []));

  function norm(p) { return path.resolve(String(p || '')); }

  // One fs.watch per directory: watching the file itself breaks on editors that save by
  // rename (the inode we watched is the stale one), the directory sees the new name land.
  function watch(abs) {
    const dir = path.dirname(abs);
    let d = dirs.get(dir);
    if (!d) {
      d = { watcher: null, files: new Set(), timers: new Map() };
      try {
        d.watcher = fs.watch(dir, (_ev, fname) => {
          if (!fname) return;
          const hit = path.join(dir, String(fname));
          if (!d.files.has(hit)) return;
          clearTimeout(d.timers.get(hit));
          d.timers.set(hit, setTimeout(() => { d.timers.delete(hit); recheck(hit); }, WATCH_DEBOUNCE_MS));
        });
        d.watcher.on('error', (e) => { log(`doc watch lost on ${dir}: ${e.message}`); try { d.watcher.close(); } catch {} d.watcher = null; });
      } catch (e) { log(`doc watch failed on ${dir}: ${e.message}`); }
      dirs.set(dir, d);
    }
    d.files.add(abs);
  }
  function unwatch(abs) {
    const dir = path.dirname(abs), d = dirs.get(dir);
    if (!d) return;
    d.files.delete(abs);
    clearTimeout(d.timers.get(abs)); d.timers.delete(abs);
    if (d.files.size === 0) { try { if (d.watcher) d.watcher.close(); } catch {} dirs.delete(dir); }
  }

  function recheck(abs) {
    const cur = open.get(abs); if (!cur) return;
    fs.stat(abs, (err, st) => {
      if (err) { if (err.code === 'ENOENT') send({ type: 'docGone', path: abs }); return; }
      if (cur.mtime === st.mtimeMs && cur.size === st.size) return;
      fs.readFile(abs, 'utf8', (e2, text) => {
        if (e2) return;
        cur.mtime = st.mtimeMs; cur.size = st.size;
        send({ type: 'docChange', path: abs, text, mtime: st.mtimeMs });
      });
    });
  }

  // Open each path: read it, remember it, watch it, hand it to the page. `select` focuses the
  // last one; `quiet` (restore at boot) drops files that no longer exist without a toast.
  // Reads go one after another: each arrival goes on top of the roster, so the last read ends
  // up first — the selected one for an explicit open, the saved top for a restore (reversed).
  async function openPaths(paths, { select = true, quiet = false, t0 = 0, reverse = false, edit = false } = {}) {
    const list = (paths || []).map(norm).filter(p => MD_RE.test(p));
    if (!list.length) return;
    if (select) focusWindow();
    const last = list[list.length - 1];
    for (const abs of reverse ? list.slice().reverse() : list) {
      let text, st = null;
      try { text = await fs.promises.readFile(abs, 'utf8'); st = await fs.promises.stat(abs); }
      catch (err) {
        log(`doc open failed ${abs}: ${err.message}`);
        if (quiet) { settings.docs = withoutDoc(docs(), abs); saveState(); continue; }
        send({ type: 'toast', text: `Could not open ${path.basename(abs)}: ${err.code === 'ENOENT' ? 'file not found' : err.message}` });
        continue;
      }
      const fresh = !open.has(abs);
      open.set(abs, { mtime: st.mtimeMs, size: st.size });
      if (fresh) watch(abs);
      const before = docs().slice();
      settings.docs = withDoc(before, abs);
      if (settings.docs.length !== before.length) saveState();
      send({ type: 'docOpen', path: abs, text, mtime: st.mtimeMs, select: select && abs === last, t0, edit: edit && abs === last });
    }
  }

  // A quick note: a new file in the notes folder, opened straight into the editor. Named by the
  // minute ("Note 2026-10-21 14-32.md"), with a counter when two land in the same minute; the tab
  // takes its title from the first heading as the user types.
  async function newNote() {
    if (!notesDir) return null;
    const d = new Date(), p2 = (n) => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}-${p2(d.getMinutes())}`;
    try {
      await fs.promises.mkdir(notesDir, { recursive: true });
      let abs = path.join(notesDir, `Note ${stamp}.md`);
      for (let i = 2; fs.existsSync(abs); i++) abs = path.join(notesDir, `Note ${stamp} (${i}).md`);
      await fs.promises.writeFile(abs, '# Note\n\n', { encoding: 'utf8', flag: 'wx' });
      await openPaths([abs], { edit: true });
      return abs;
    } catch (e) { log(`note create failed: ${e.message}`); send({ type: 'toast', text: `Could not create a note: ${e.message}` }); return null; }
  }

  function close(abs) {
    abs = norm(abs);
    if (!open.delete(abs)) return;
    unwatch(abs);
    settings.docs = withoutDoc(docs(), abs);
    saveState();
  }

  function restore() { return openPaths(docs(), { select: false, quiet: true, reverse: true }); }

  function dispose() { for (const d of dirs.values()) { try { if (d.watcher) d.watcher.close(); } catch {} } dirs.clear(); open.clear(); }

  // ── Windows: register as a markdown viewer in HKCU (no admin). The ProgID carries the
  // open command and icon; .md/.markdown point at it; Capabilities make Overlord show in
  // Settings → Default apps. Windows keeps the user's own choice (UserChoice) over all of this,
  // so when one exists for .md we open that Settings page so the user can pick Overlord there.
  function reg(args) {
    return new Promise((resolve, reject) => execFile('reg', args, { windowsHide: true }, (err, out) => err ? reject(new Error((out || err.message).trim())) : resolve(String(out))));
  }
  async function associate() {
    if (platform !== 'win32') return { ok: false, error: 'File association is set up on Windows only. On other systems, choose Overlord in the file\'s "Open with" menu.' };
    const exe = execPath;
    const cmd = isPackaged ? `"${exe}" "%1"` : `"${exe}" "${appPath}" "%1"`;
    const CLS = 'HKCU\\Software\\Classes';
    const ops = [
      [`${CLS}\\${PROGID}`, '/ve', '/d', 'Markdown Document'],
      [`${CLS}\\${PROGID}`, '/v', 'FriendlyTypeName', '/d', 'Markdown Document'],
      [`${CLS}\\${PROGID}\\DefaultIcon`, '/ve', '/d', `"${exe}",0`],
      [`${CLS}\\${PROGID}\\shell\\open`, '/ve', '/d', 'Open in Overlord'],
      [`${CLS}\\${PROGID}\\shell\\open\\command`, '/ve', '/d', cmd],
      [`${CLS}\\Applications\\Overlord.exe\\shell\\open\\command`, '/ve', '/d', cmd],
      [`${CLS}\\Applications\\Overlord.exe`, '/v', 'FriendlyAppName', '/d', 'Overlord'],
      [`${CLS}\\Applications\\Overlord.exe\\SupportedTypes`, '/v', '.md', '/d', ''],
      [`${CLS}\\Applications\\Overlord.exe\\SupportedTypes`, '/v', '.markdown', '/d', ''],
      ['HKCU\\Software\\Overlord\\Capabilities', '/v', 'ApplicationName', '/d', 'Overlord'],
      ['HKCU\\Software\\Overlord\\Capabilities', '/v', 'ApplicationDescription', '/d', 'Claude agent manager and markdown viewer'],
      ['HKCU\\Software\\Overlord\\Capabilities\\FileAssociations', '/v', '.md', '/d', PROGID],
      ['HKCU\\Software\\Overlord\\Capabilities\\FileAssociations', '/v', '.markdown', '/d', PROGID],
      ['HKCU\\Software\\RegisteredApplications', '/v', 'Overlord', '/d', 'Software\\Overlord\\Capabilities'],
    ];
    for (const ext of ['.md', '.markdown']) {
      ops.push([`${CLS}\\${ext}\\OpenWithProgids`, '/v', PROGID, '/d', '']);
      ops.push([`${CLS}\\${ext}`, '/ve', '/d', PROGID]);
      ops.push([`${CLS}\\${ext}`, '/v', 'Content Type', '/d', 'text/markdown']);
      ops.push([`${CLS}\\${ext}`, '/v', 'PerceivedType', '/d', 'text']);
    }
    try { for (const op of ops) await reg(['add', ...op, '/f']); }
    catch (e) { return { ok: false, error: e.message }; }
    // Did the user ever pick a viewer for .md by hand? Then Windows ignores the class default.
    let chosen = '';
    try {
      const out = await reg(['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts\\.md\\UserChoice', '/v', 'ProgId']);
      const m = /ProgId\s+REG_SZ\s+(\S+)/i.exec(out); chosen = m ? m[1] : '';
    } catch {}
    if (chosen && chosen !== PROGID) {
      try { await openExternal('ms-settings:defaultapps?registeredAppUser=Overlord'); } catch {}
      return { ok: true, needsPick: true, chosen };
    }
    return { ok: true, needsPick: false };
  }

  function handle(msg) {
    switch (msg.type) {
      case 'docOpen': openPaths(msg.paths || (msg.path ? [msg.path] : []), { select: msg.select !== false, quiet: !!msg.quiet }); return true;
      case 'docClose': close(msg.path); return true;
      case 'docWrite': { // the page edited an open document (a task checkbox): write it, and don't echo it back as a change
        const abs = norm(msg.path); const cur = open.get(abs);
        if (!cur || typeof msg.text !== 'string') return true;
        fs.writeFile(abs, msg.text, 'utf8', (err) => {
          if (err) { send({ type: 'toast', text: `Could not save ${path.basename(abs)}: ${err.message}` }); return; }
          try { const st = fs.statSync(abs); cur.mtime = st.mtimeMs; cur.size = st.size; } catch {}
        });
        return true;
      }
      case 'docShown': { if (msg.t0) log(`doc shown ${path.basename(String(msg.path || ''))} in ${Date.now() - msg.t0}ms (${msg.where || 'launch'})`); return true; }
      case 'docNew': newNote(); return true;
      case 'docPick':
        Promise.resolve(showOpenDialog({ title: 'Open markdown', defaultPath: msg.dir && fs.existsSync(msg.dir) ? msg.dir : undefined, filters: [{ name: 'Markdown', extensions: ['md', 'markdown', 'mdown', 'mkd'] }], properties: ['openFile', 'multiSelections'] }))
          .then(r => { if (r && !r.canceled && r.filePaths && r.filePaths.length) openPaths(r.filePaths); }).catch(e => log(`doc pick failed: ${e.message}`));
        return true;
      case 'docReveal': if (msg.path) showItemInFolder(norm(msg.path)); return true;
      case 'docOpenWith': if (msg.path) Promise.resolve(openPath(norm(msg.path))).then(err => { if (err) send({ type: 'toast', text: `Could not open: ${err}` }); }).catch(() => {}); return true;
      case 'docAssociate':
        associate().then(r => {
          send({ type: 'docAssociated', ...r });
          send({ type: 'toast', text: !r.ok ? `Could not register: ${r.error}` : r.needsPick ? 'Overlord is registered — pick it for .md in the Windows page that just opened' : '.md files now open in Overlord' });
        });
        return true;
      default: return false;
    }
  }

  return { openPaths, restore, close, handle, dispose, newNote, isOpen: (p) => open.has(norm(p)), _associate: associate };
};
