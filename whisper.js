// Speech to text for the Chat view's mic. Locally: whisper.cpp. With an NVIDIA GPU it runs the large-v3-turbo model on
// CUDA (~1.3 GB, once); otherwise small on the CPU (~200 MB). Both hear English and Hebrew. Both download into userData the
// first time the mic is used, with progress, resumable, checked against pinned SHA-256s. whisper-server keeps the model
// loaded, at low priority, for 5 idle minutes. A CUDA build that won't start twice running (driver too old, GPU busy)
// falls back to the CPU kit for a day, then tries the GPU again. With an OpenAI (sk-…) or Groq (gsk_…) key in Settings, takes go to that cloud instead.
const fs = require('fs'), path = require('path'), os = require('os'), net = require('net'), crypto = require('crypto');
const { spawn } = require('child_process');

const SYS = (exe) => path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', exe); // Windows' own tar: Git's tar on PATH reads "C:" as a host
const REL = 'https://github.com/ggml-org/whisper.cpp/releases/download/b5454/', HF = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/';
const KITS = {
  cuda: { bin: 'cuda', zip: REL + 'whisper-bin-win-cuda-12.4.0-x64.zip', zipSha: 'afef0b881c500958921c3f5523b50e59ee2ec9b6f5cbd25b324c51ed308a957a',
    model: 'ggml-large-v3-turbo-q5_0.bin', modelSha: '394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2', threads: 4 },
  cpu: { bin: 'cpu', zip: REL + 'whisper-bin-x64.zip', zipSha: '6ba69e3482d7826214f90a6a9c84ca07782aec1e1d0c6a7c30c994fd5d816ccb',
    model: 'ggml-small-q5_1.bin', modelSha: 'ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb', threads: Math.min(8, os.availableParallelism ? os.availableParallelism() : os.cpus().length) },
};
const GPU = fs.existsSync(SYS('nvidia-smi.exe')); // NVIDIA's driver puts it there
const DAY = 24 * 3600 * 1000, cpuOnly = (dir) => { try { return Date.now() - fs.statSync(path.join(dir, 'cpu-only')).mtimeMs < DAY; } catch { return false; } };
const kit = (dir) => GPU && !cpuOnly(dir) ? KITS.cuda : KITS.cpu;
const IDLE_MS = 5 * 60 * 1000;

const low = (p) => { try { os.setPriority(p.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch {} return p; };
const paths = (dir, k = kit(dir)) => ({ server: path.join(dir, k.bin, 'Release', 'whisper-server.exe'), model: path.join(dir, k.model) });
const installed = (dir) => { const p = paths(dir); return fs.existsSync(p.server) && fs.existsSync(p.model); };

// What whisper writes for silence or noise rather than words: "[BLANK_AUDIO]", "(wind blowing)", "[Music]".
// A lone "-" or "..." is silence too, and a line opened with "- " is whisper writing dialogue. Nothing but
// punctuation left means no words. Given silence and a vocabulary hint, whisper can also just read the hint back.
function cleanText(s, hint = '') {
  s = s.replace(/\[[^\]]*\]|\([^)]*\)/g, ' ').replace(/^\s*[-–—]+\s*/gm, '').replace(/\s+/g, ' ').trim();
  if (s.length >= 12 && hint.toLowerCase().includes(s.replace(/[.!?]$/, '').toLowerCase())) return '';
  if (/^(you|thank you|thanks for watching)[.!]?$/i.test(s)) return ''; // what whisper says to a quiet room
  return /[\p{L}\p{N}]/u.test(s) ? s : '';
}

async function sha256(file) { const h = crypto.createHash('sha256'); for await (const c of fs.createReadStream(file)) h.update(c); return h.digest('hex'); }

// Downloads to file, reporting bytes as they arrive. A .part left by an earlier try carries on where it stopped.
async function download(url, file, sha, onBytes) {
  const part = file + '.part'; let have = fs.existsSync(part) ? fs.statSync(part).size : 0;
  const r = await fetch(url, have ? { headers: { Range: `bytes=${have}-` } } : {});
  if (r.status !== 416) { // 416: the .part is already whole
    if (!r.ok) throw new Error(`download failed: ${r.status}`);
    if (r.status !== 206) have = 0; // the server ignored the range: start over
    onBytes(have);
    const out = fs.createWriteStream(part, { flags: have ? 'a' : 'w' });
    try { for await (const c of r.body) { if (!out.write(c)) await new Promise((res) => out.once('drain', res)); onBytes(c.length); } }
    finally { await new Promise((res) => out.end(res)); }
  }
  if (await sha256(part) !== sha) { fs.rmSync(part, { force: true }); throw new Error('speech engine download was corrupted, try again'); }
  fs.renameSync(part, file);
}

let ready = null; // one install at a time; everyone asking while it runs shares it
function ensure(dir, onProgress = () => {}) {
  if (installed(dir)) return Promise.resolve(paths(dir));
  return ready || (ready = (async () => {
    fs.mkdirSync(dir, { recursive: true });
    const k = kit(dir), p = paths(dir, k), zip = path.join(dir, k.bin + '.zip');
    const jobs = [!fs.existsSync(p.server) && [k.zip, zip, k.zipSha], !fs.existsSync(p.model) && [HF + k.model, p.model, k.modelSha]].filter(Boolean);
    const sizes = await Promise.all(jobs.map(async ([u]) => +(await fetch(u, { method: 'HEAD' })).headers.get('content-length') || 0));
    const total = sizes.reduce((a, b) => a + b, 0) || 1; let got = 0, shown = -1;
    const tick = (n) => { got += n; const pct = Math.min(99, Math.floor(got / total * 100)); if (pct !== shown) { shown = pct; onProgress(pct); } };
    onProgress(0);
    for (const [u, f, sha] of jobs) await download(u, f, sha, tick);
    if (fs.existsSync(zip)) {
      fs.mkdirSync(path.join(dir, k.bin), { recursive: true });
      await new Promise((res, rej) => low(spawn(SYS('tar.exe'), ['-xf', zip, '-C', path.join(dir, k.bin)], { windowsHide: true })).on('exit', (c) => c ? rej(new Error('unzip failed')) : res()).on('error', rej)); // the zip's root is Release/
      fs.rmSync(zip, { force: true });
    }
    if (!installed(dir)) throw new Error('speech engine download is incomplete');
    fs.rmSync(path.join(dir, 'ggml-small.en-q5_1.bin'), { force: true }); // the English-only model before 1.212.2
    return p;
  })().finally(() => { ready = null; }));
}

const freePort = () => new Promise((res, rej) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }).on('error', rej); });

async function start(dir, s, onProgress) {
  const { server: exe, model } = await ensure(dir, onProgress), k = kit(dir), port = await freePort();
  const proc = s.proc = low(spawn(exe, ['-m', model, '--host', '127.0.0.1', '--port', String(port), '-t', String(k.threads), '-l', 'auto', '-nt'], { windowsHide: true, stdio: 'ignore' }));
  proc.on('exit', () => { if (server === s && s.proc === proc && s.up) server = null; }); // dying while it starts is start()'s to handle (the CPU fallback)
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 300; i++) { // the model loads in 1-3 s
    if (s.proc.exitCode != null) throw Object.assign(new Error('speech engine failed to start'), { died: true });
    try { if ((await fetch(url)).ok) { s.up = true; return url; } } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('speech engine did not start');
}

let server = null, idle = null; // { proc, url: Promise<string> }
function stop() { clearTimeout(idle); if (server) { try { server.proc && server.proc.kill(); } catch {} server = null; } }
function serverUrl(dir, onProgress) {
  clearTimeout(idle); idle = setTimeout(stop, IDLE_MS);
  if (server) return server.url;
  const s = server = { proc: null };
  const gpuDied = (e) => e.died && kit(dir) === KITS.cuda;
  s.url = start(dir, s, onProgress)
    .catch((e) => { if (!gpuDied(e)) throw e; return start(dir, s, onProgress); }) // once can be the GPU busy for a moment
    .catch((e) => {
      if (!gpuDied(e)) throw e;
      // Twice: the CUDA build won't run here (a driver older than CUDA 12.4, or no VRAM free). The CPU kit for a day; the GPU kit stays.
      fs.writeFileSync(path.join(dir, 'cpu-only'), '');
      return start(dir, s, onProgress);
    });
  s.url.catch(() => { if (server === s) stop(); });
  return s.url;
}

// Installs if needed and loads the model, so the first take after this is quick.
const warm = (dir, onProgress) => serverUrl(dir, onProgress).then(() => {});

// Auto-detect is for English and Hebrew. English with an accent can be heard as Hebrew or some third language, so only a
// sure Hebrew stays Hebrew; the rest is written as English.
const keepLanguage = (lang, p) => !lang || lang === 'english' || (lang === 'hebrew' && p >= 0.8);

// hint: words whisper can't guess from sound alone (names, files on screen); it spells what it hears their way.
async function transcribe(dir, wav, hint = '') {
  const url = await serverUrl(dir);
  const ask = async (language) => {
    const form = new FormData();
    form.append('file', new Blob([wav], { type: 'audio/wav' }), 'take.wav');
    form.append('response_format', 'verbose_json');
    if (hint) form.append('prompt', hint);
    if (language) form.append('language', language);
    const r = await fetch(url + '/inference', { method: 'POST', body: form });
    if (!r.ok) throw new Error(`speech engine: ${r.status}`);
    return r.json();
  };
  let j = await ask();
  if (!keepLanguage(j.detected_language, j.detected_language_probability)) j = await ask('en');
  return cleanText(j.text || '', hint);
}

// The cloud: Groq for gsk_ keys, otherwise OpenAI. Both auto-detect the language.
async function transcribeCloud(key, wav, hint = '') {
  const groq = key.startsWith('gsk_'), form = new FormData();
  form.append('file', new Blob([wav], { type: 'audio/wav' }), 'take.wav');
  form.append('model', groq ? 'whisper-large-v3-turbo' : 'gpt-4o-transcribe');
  form.append('response_format', 'text');
  if (hint) form.append('prompt', hint);
  const r = await fetch(groq ? 'https://api.groq.com/openai/v1/audio/transcriptions' : 'https://api.openai.com/v1/audio/transcriptions',
    { method: 'POST', headers: { Authorization: 'Bearer ' + key }, body: form });
  if (!r.ok) { let m = ''; try { m = (await r.json()).error.message; } catch {} throw new Error(`${groq ? 'Groq' : 'OpenAI'} ${r.status}${m ? ': ' + m : ''}`); }
  return cleanText(await r.text(), hint);
}

// Deletes the downloaded engine; returns the bytes freed.
function remove(dir) {
  stop();
  let n = 0; const walk = (p) => { try { const st = fs.statSync(p); if (st.isDirectory()) for (const f of fs.readdirSync(p)) walk(path.join(p, f)); else n += st.size; } catch {} };
  walk(dir); fs.rmSync(dir, { recursive: true, force: true });
  return n;
}

module.exports = { keepLanguage, transcribe, transcribeCloud, warm, installed, cleanText, stop, remove, download };
