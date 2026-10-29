// Speech to text for the Chat view's mic: whisper.cpp on this machine. The binary and the English model (~160 MB)
// download once into userData on the first take; each take is a 16 kHz WAV the page recorded, transcribed at low
// priority. ponytail: base.en model; small.en if accuracy still falls short (3x the size, ~2x slower).
const fs = require('fs'), path = require('path'), os = require('os');
const { execFile } = require('child_process');

const BIN_URL = 'https://github.com/ggml-org/whisper.cpp/releases/download/b5454/whisper-bin-x64.zip';
const SYS = (exe) => path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', exe); // Windows' own curl/tar: Git's tar on PATH reads "C:" as a host
const MODEL_URL = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin';

const run = (cmd, args, opts = {}) => new Promise((res, rej) => {
  const p = execFile(cmd, args, { windowsHide: true, maxBuffer: 16 << 20, ...opts }, (e, out, err) => e ? rej(new Error((err || e.message).toString().trim().split('\n').pop())) : res(out.toString()));
  try { os.setPriority(p.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch {}
});

// What whisper writes for silence or noise rather than words: "[BLANK_AUDIO]", "(wind blowing)", "[Music]".
function cleanText(s) { return s.replace(/\[[^\]]*\]|\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim(); }

let ready = null; // one download at a time, shared by takes that arrive during it
function ensure(dir, onProgress) {
  const cli = path.join(dir, 'bin', 'Release', 'whisper-cli.exe'), model = path.join(dir, 'ggml-base.en.bin');
  if (fs.existsSync(cli) && fs.existsSync(model)) return Promise.resolve({ cli, model });
  return ready || (ready = (async () => {
    fs.mkdirSync(dir, { recursive: true });
    onProgress('Downloading speech engine (one time, ~160 MB)…');
    if (!fs.existsSync(cli)) {
      const zip = path.join(dir, 'bin.zip');
      await run(SYS('curl.exe'), ['-sSfL', '-o', zip, BIN_URL]);
      fs.mkdirSync(path.join(dir, 'bin'), { recursive: true });
      await run(SYS('tar.exe'), ['-xf', zip, '-C', path.join(dir, 'bin')]); // the zip's root is Release/
      fs.rmSync(zip, { force: true });
    }
    if (!fs.existsSync(model)) { await run(SYS('curl.exe'), ['-sSfL', '-o', model + '.part', MODEL_URL]); fs.renameSync(model + '.part', model); }
    if (!fs.existsSync(cli)) throw new Error('speech engine download is incomplete');
    return { cli, model };
  })().finally(() => { ready = null; }));
}

async function transcribe(dir, wav, onProgress) {
  const { cli, model } = await ensure(dir, onProgress);
  const f = path.join(os.tmpdir(), `overlord-take-${process.pid}-${Date.now()}.wav`);
  fs.writeFileSync(f, wav);
  try { return cleanText(await run(cli, ['-m', model, '-f', f, '-nt', '-np', '-t', '8'])); }
  finally { fs.rmSync(f, { force: true }); }
}

module.exports = { transcribe, cleanText };
