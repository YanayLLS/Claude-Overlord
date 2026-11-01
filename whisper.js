// Speech to text for the Chat view's mic: whisper.cpp on this machine. The binary and the English model (~160 MB)
// download once into userData on the first take. whisper-server keeps the model loaded while you dictate, so the page
// can send what you've said so far every second and show it live; it runs at low priority and exits after 5 idle
// minutes or with the app. ponytail: base.en model; small.en if accuracy still falls short (3x the size, ~2x slower).
const fs = require('fs'), path = require('path'), os = require('os'), net = require('net');
const { execFile, spawn } = require('child_process');

const BIN_URL = 'https://github.com/ggml-org/whisper.cpp/releases/download/b5454/whisper-bin-x64.zip';
const MODEL_URL = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin';
const SYS = (exe) => path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', exe); // Windows' own curl/tar: Git's tar on PATH reads "C:" as a host
const IDLE_MS = 5 * 60 * 1000;

const low = (p) => { try { os.setPriority(p.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch {} return p; };
const run = (cmd, args, opts = {}) => new Promise((res, rej) => {
  low(execFile(cmd, args, { windowsHide: true, maxBuffer: 16 << 20, ...opts }, (e, out, err) => e ? rej(new Error((err || e.message).toString().trim().split('\n').pop())) : res(out.toString())));
});

// What whisper writes for silence or noise rather than words: "[BLANK_AUDIO]", "(wind blowing)", "[Music]".
function cleanText(s) { return s.replace(/\[[^\]]*\]|\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim(); }

let ready = null; // one download at a time, shared by takes that arrive during it
function ensure(dir, onProgress) {
  const bin = path.join(dir, 'bin', 'Release'), model = path.join(dir, 'ggml-base.en.bin');
  if (fs.existsSync(path.join(bin, 'whisper-server.exe')) && fs.existsSync(model)) return Promise.resolve({ bin, model });
  return ready || (ready = (async () => {
    fs.mkdirSync(dir, { recursive: true });
    onProgress('Downloading speech engine (one time, ~160 MB)…');
    if (!fs.existsSync(path.join(bin, 'whisper-server.exe'))) {
      const zip = path.join(dir, 'bin.zip');
      await run(SYS('curl.exe'), ['-sSfL', '-o', zip, BIN_URL]);
      fs.mkdirSync(path.join(dir, 'bin'), { recursive: true });
      await run(SYS('tar.exe'), ['-xf', zip, '-C', path.join(dir, 'bin')]); // the zip's root is Release/
      fs.rmSync(zip, { force: true });
    }
    if (!fs.existsSync(model)) { await run(SYS('curl.exe'), ['-sSfL', '-o', model + '.part', MODEL_URL]); fs.renameSync(model + '.part', model); }
    if (!fs.existsSync(path.join(bin, 'whisper-server.exe'))) throw new Error('speech engine download is incomplete');
    return { bin, model };
  })().finally(() => { ready = null; }));
}

const freePort = () => new Promise((res, rej) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }).on('error', rej); });

let server = null, idle = null; // { proc, url: Promise<string> }
function stop() { clearTimeout(idle); if (server) { try { server.proc.kill(); } catch {} server = null; } }
function serverUrl(dir, onProgress) {
  clearTimeout(idle); idle = setTimeout(stop, IDLE_MS);
  if (server) return server.url;
  const s = server = { proc: null };
  s.url = (async () => {
    const { bin, model } = await ensure(dir, onProgress);
    const port = await freePort();
    s.proc = low(spawn(path.join(bin, 'whisper-server.exe'), ['-m', model, '--host', '127.0.0.1', '--port', String(port), '-t', '8', '-nt'], { windowsHide: true, stdio: 'ignore' }));
    s.proc.on('exit', () => { if (server === s) server = null; });
    const url = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 100; i++) { // the model loads in ~1 s
      if (s.proc.exitCode != null) throw new Error('speech engine failed to start');
      try { if ((await fetch(url)).ok) return url; } catch {}
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('speech engine did not start');
  })();
  s.url.catch(() => { if (server === s) stop(); });
  return s.url;
}

async function transcribe(dir, wav, onProgress) {
  const url = await serverUrl(dir, onProgress);
  const form = new FormData();
  form.append('file', new Blob([wav], { type: 'audio/wav' }), 'take.wav');
  form.append('response_format', 'text');
  const r = await fetch(url + '/inference', { method: 'POST', body: form });
  if (!r.ok) throw new Error(`speech engine: ${r.status}`);
  return cleanText(await r.text());
}

module.exports = { transcribe, cleanText, stop };
