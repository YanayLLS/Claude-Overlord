// ovl-start.cmd's half that talks to Overlord. Exit 0 = the tab opened; anything else = caller falls back to start.
const fs = require('fs');
const path = require('path');
const http = require('http');
const { parseStartArgs } = require('./term-pane-core');

const stateDir = process.env.OVERLORD_STATE_DIR || path.join(require('os').homedir(), '.overlord');
let info;
try { info = JSON.parse(fs.readFileSync(path.join(stateDir, 'term-pane.json'), 'utf8')); } catch { process.exit(2); }
const job = parseStartArgs(process.argv.slice(2), process.cwd());
if (!job) process.exit(3);
const body = JSON.stringify({ ...job, env: process.env });
const req = http.request({ host: '127.0.0.1', port: info.port, path: '/open', method: 'POST', timeout: 3000,
  headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'x-ovl-token': info.token } },
  (res) => { res.resume(); res.on('end', () => process.exit(res.statusCode === 200 ? 0 : 4)); });
req.on('error', () => process.exit(5));
req.on('timeout', () => { req.destroy(); process.exit(6); });
req.end(body);
