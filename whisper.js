// Speech to text for the Chat view's mic: whisper.cpp on this machine. With an NVIDIA GPU it runs the large-v3-turbo
// model on CUDA (~1.3 GB, once); otherwise small.en on the CPU (~200 MB). Both download into userData the first time
// the mic is used, with progress. whisper-server keeps the model loaded, at low priority, for 5 idle minutes.
// ponytail: a CUDA build too new for an old NVIDIA driver fails to start; fall back to the CPU kit if that turns up.
const fs = require('fs'), path = require('path'), os = require('os'), net = require('net');
const { spawn } = require('child_process');

const SYS = (exe) => path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', exe); // Windows' own tar: Git's tar on PATH reads "C:" as a host
const REL = 'https://github.com/ggml-org/whisper.cpp/releases/download/b5454/', HF = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/';
const GPU = fs.existsSync(SYS('nvidia-smi.exe')); // NVIDIA's driver puts it there
const KIT = GPU
  ? { bin: 'cuda', zip: REL + 'whisper-bin-win-cuda-12.4.0-x64.zip', model: 'ggml-large-v3-turbo-q5_0.bin', threads: 4 }
  : { bin: 'cpu', zip: REL + 'whisper-bin-x64.zip', model: 'ggml-small.en-q5_1.bin', threads: 8 };
const IDLE_MS = 5 * 60 * 1000;

const low = (p) => { try { os.setPriority(p.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch {} return p; };
const paths = (dir) => ({ server: path.join(dir, KIT.bin, 'Release', 'whisper-server.exe'), model: path.join(dir, KIT.model) });
const installed = (dir) => { const p = paths(dir); return fs.existsSync(p.server) && fs.existsSync(p.model); };

// What whisper writes for silence or noise rather than words: "[BLANK_AUDIO]", "(wind blowing)", "[Music]".
function cleanText(s) { return s.replace(/\[[^\]]*\]|\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim(); }

// Downloads to file, reporting bytes as they arrive.
async function download(url, file, onBytes) {
  const r = await fetch(url); if (!r.ok) throw new Error(`download failed: ${r.status}`);
  const out = fs.createWriteStream(file + '.part');
  try { for await (const c of r.body) { if (!out.write(c)) await new Promise((res) => out.once('drain', res)); onBytes(c.length); } }
  finally { await new Promise((res) => out.end(res)); }
  fs.renameSync(file + '.part', file);
}

let ready = null; // one install at a time; everyone asking while it runs shares it
function ensure(dir, onProgress = () => {}) {
  if (installed(dir)) return Promise.resolve(paths(dir));
  return ready || (ready = (async () => {
    fs.mkdirSync(dir, { recursive: true });
    const p = paths(dir), zip = path.join(dir, KIT.bin + '.zip');
    const jobs = [!fs.existsSync(p.server) && [KIT.zip, zip], !fs.existsSync(p.model) && [HF + KIT.model, p.model]].filter(Boolean);
    const sizes = await Promise.all(jobs.map(async ([u]) => +(await fetch(u, { method: 'HEAD' })).headers.get('content-length') || 0));
    const total = sizes.reduce((a, b) => a + b, 0) || 1; let got = 0, shown = -1;
    const tick = (n) => { got += n; const pct = Math.min(99, Math.floor(got / total * 100)); if (pct !== shown) { shown = pct; onProgress(pct); } };
    onProgress(0);
    for (const [u, f] of jobs) await download(u, f, tick);
    if (fs.existsSync(zip)) {
      fs.mkdirSync(path.join(dir, KIT.bin), { recursive: true });
      await new Promise((res, rej) => low(spawn(SYS('tar.exe'), ['-xf', zip, '-C', path.join(dir, KIT.bin)], { windowsHide: true })).on('exit', (c) => c ? rej(new Error('unzip failed')) : res()).on('error', rej)); // the zip's root is Release/
      fs.rmSync(zip, { force: true });
    }
    if (!installed(dir)) throw new Error('speech engine download is incomplete');
    return p;
  })().finally(() => { ready = null; }));
}

const freePort = () => new Promise((res, rej) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }).on('error', rej); });

let server = null, idle = null; // { proc, url: Promise<string> }
function stop() { clearTimeout(idle); if (server) { try { server.proc && server.proc.kill(); } catch {} server = null; } }
function serverUrl(dir, onProgress) {
  clearTimeout(idle); idle = setTimeout(stop, IDLE_MS);
  if (server) return server.url;
  const s = server = { proc: null };
  s.url = (async () => {
    const { server: exe, model } = await ensure(dir, onProgress);
    const port = await freePort();
    s.proc = low(spawn(exe, ['-m', model, '--host', '127.0.0.1', '--port', String(port), '-t', String(KIT.threads), '-l', 'en', '-nt'], { windowsHide: true, stdio: 'ignore' }));
    s.proc.on('exit', () => { if (server === s) server = null; });
    const url = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 300; i++) { // the model loads in 1-3 s
      if (s.proc.exitCode != null) throw new Error('speech engine failed to start');
      try { if ((await fetch(url)).ok) return url; } catch {}
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('speech engine did not start');
  })();
  s.url.catch(() => { if (server === s) stop(); });
  return s.url;
}

// Installs if needed and loads the model, so the first take after this is quick.
const warm = (dir, onProgress) => serverUrl(dir, onProgress).then(() => {});

async function transcribe(dir, wav) {
  const url = await serverUrl(dir);
  const form = new FormData();
  form.append('file', new Blob([wav], { type: 'audio/wav' }), 'take.wav');
  form.append('response_format', 'text');
  const r = await fetch(url + '/inference', { method: 'POST', body: form });
  if (!r.ok) throw new Error(`speech engine: ${r.status}`);
  return cleanText(await r.text());
}

module.exports = { transcribe, warm, installed, cleanText, stop };
