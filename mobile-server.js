// Phone companion: Overlord's chats on a phone browser. One HTTP server on the LAN (off until Settings → Phone turns it
// on) that serves mobile/index.html and a narrow slice of the local API (api-core.js) behind its own pairing token:
// reading agents and transcripts, sending prompts, answering what an agent waits on, stopping a turn, peer chat.
// Nothing that creates, closes or reconfigures. The token travels in the QR code's URL fragment (#k=…), which browsers
// never send to a server, and after that only in the Authorization header, so it is in no URL, log or Referer.
//   GET  /                  → the mobile page (no token: it holds nothing secret)
//   GET  /md.js             → the markdown bundle (md-bundle.js), when it is built
//   GET  /m/health          → { ok } (no token)
//   GET  /m/events          → SSE of agent.* and chat.* events (Last-Event-ID / ?since= resume, as /v1/events)
//   POST /m/<tool>          → one of MOBILE_TOOLS, as POST /v1/<tool>
// Self-check: mobile-server.test.js
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { tokenOk, parseFilter, wants, ApiError } = require('./api-core');

const MOBILE_DEFAULT_PORT = 7791;
const MAX_BODY = 1024 * 1024;
const MOBILE_TOOLS = new Set([
  'overlord_info', 'agents_list', 'agent_get', 'agent_transcript', 'agent_screen',
  'agent_send', 'permission_answer', 'question_answer', 'agent_interrupt', 'agent_wake',
  'chat_list', 'chat_read', 'chat_send',
]);
const MOBILE_EVENTS = ['agent.', 'chat.'];
// Wrong tokens: this many from one address within a minute and it is shut out for the rest of that minute.
const BAD_MAX = 10, BAD_WINDOW_MS = 60000;

// Addresses a phone could reach this computer on, best first: Tailscale (100.64/10, works off the home network too),
// then private LAN ranges, then anything else that isn't loopback or link-local.
function lanAddresses(nets = os.networkInterfaces()) {
  const out = [];
  for (const [name, list] of Object.entries(nets || {})) {
    for (const n of list || []) {
      if (n.family !== 'IPv4' && n.family !== 4) continue;
      if (n.internal || /^127\./.test(n.address) || /^169\.254\./.test(n.address)) continue;
      const [a, b] = n.address.split('.').map(Number);
      const kind = a === 100 && b >= 64 && b < 128 ? 'tailscale'
        : a === 10 || (a === 172 && b >= 16 && b < 32) || (a === 192 && b === 168) ? 'lan' : 'other';
      out.push({ address: n.address, iface: name, kind });
    }
  }
  const rank = { tailscale: 0, lan: 1, other: 2 };
  // Virtual adapters (WSL, Hyper-V, VirtualBox, Docker) are private too, but a phone can't reach them.
  const virt = (x) => /vethernet|wsl|hyper-v|virtualbox|vmware|docker|vbox|loopback/i.test(x.iface) ? 1 : 0;
  return out.sort((x, y) => rank[x.kind] - rank[y.kind] || virt(x) - virt(y));
}

const pairUrl = (address, port, token) => `http://${address}:${port}/#k=${encodeURIComponent(token)}`;

// An SVG of the QR code for text (vendor/qrcode.js), dark modules on transparent.
function qrSvg(text) {
  const qrcode = require('./vendor/qrcode.js');
  const q = qrcode(0, 'M'); q.addData(text); q.make();
  const n = q.getModuleCount(), m = 2;
  let d = '';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.isDark(r, c)) d += `M${c + m} ${r + m}h1v1h-1z`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n + 2 * m} ${n + 2 * m}" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on('data', (c) => { n += c.length; if (n > MAX_BODY) { reject(new ApiError(413, 'body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
const SEC = {
  'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY',
};
function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { ...SEC, 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}
const PAGE_CSP = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

// api: a createApi(...) result. getToken: () => the current pairing token. root: folder holding mobile/ and md-bundle.js.
function createMobileServer({ api, getToken, root = __dirname, log = () => {}, now = Date.now }) {
  let server = null;
  const streams = new Set();
  const bad = new Map(); // address → { n, since }

  function locked(ip) { const b = bad.get(ip); if (!b) return false; if (now() - b.since > BAD_WINDOW_MS) { bad.delete(ip); return false; } return b.n >= BAD_MAX; }
  function strike(ip) { const b = bad.get(ip); if (!b || now() - b.since > BAD_WINDOW_MS) bad.set(ip, { n: 1, since: now() }); else b.n++; }

  function file(res, rel, type, extra = {}) {
    let body; try { body = fs.readFileSync(path.join(root, rel)); } catch { return json(res, 404, { error: 'not found' }); }
    res.writeHead(200, { ...SEC, 'content-type': type, 'content-length': body.length, ...extra });
    res.end(body);
  }

  function sse(req, res, url) {
    const asked = parseFilter(url.searchParams.get('types'));
    const filter = asked.length ? asked.filter(t => wants(MOBILE_EVENTS, t)) : MOBILE_EVENTS;
    const from = Number(req.headers['last-event-id'] || url.searchParams.get('since') || NaN);
    res.writeHead(200, { ...SEC, 'content-type': 'text/event-stream; charset=utf-8', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    const write = (ev) => res.write(`id: ${ev.seq}\nevent: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);
    res.write(`retry: 3000\n\n`);
    if (Number.isFinite(from)) for (const ev of api.since(from, filter)) write(ev);
    const off = api.subscribe((ev) => { if (wants(filter, ev.type)) write(ev); });
    const beat = setInterval(() => res.write(': ping\n\n'), 15000);
    const s = { res, close: () => { clearInterval(beat); off(); streams.delete(s); } };
    streams.add(s);
    req.on('close', s.close);
  }

  async function onRequest(req, res) {
    const ip = req.socket.remoteAddress || '';
    const url = new URL(req.url, 'http://phone');
    const p = url.pathname.replace(/\/+$/, '') || '/';
    if (req.method === 'GET' && (p === '/' || p === '/index.html')) return file(res, 'mobile/index.html', 'text/html; charset=utf-8', { 'content-security-policy': PAGE_CSP });
    if (req.method === 'GET' && p === '/md.js') return file(res, 'md-bundle.js', 'text/javascript; charset=utf-8');
    if (req.method === 'GET' && p === '/manifest.webmanifest') return json(res, 200, { name: 'Overlord', short_name: 'Overlord', start_url: '/', display: 'standalone', background_color: '#0f1115', theme_color: '#0f1115' });
    if (req.method === 'GET' && p === '/m/health') return json(res, 200, { ok: true });
    if (!p.startsWith('/m/')) return json(res, 404, { error: 'not found' });
    if (locked(ip)) return json(res, 429, { error: 'too many wrong tokens: wait a minute' });
    if (!tokenOk(req.headers.authorization, getToken())) { strike(ip); return json(res, 401, { error: 'not paired: scan the QR code in Overlord → Settings → Phone' }); }

    if (req.method === 'GET' && p === '/m/events') return sse(req, res, url);
    const m = /^\/m\/([a-z_]+)$/.exec(p);
    if (!m || !MOBILE_TOOLS.has(m[1])) return json(res, 404, { error: 'not found' });
    if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
    const raw = await readBody(req);
    let args = {};
    if (raw.trim()) { try { args = JSON.parse(raw); } catch { throw new ApiError(400, 'body is not JSON'); } }
    return json(res, 200, await api.call(m[1], args));
  }

  function start(preferredPort) {
    const listen = (port) => new Promise((resolve, reject) => {
      const srv = http.createServer((req, res) => {
        onRequest(req, res).catch((e) => {
          const status = e instanceof ApiError ? e.status : 500;
          if (status === 500) log(`phone ${req.method} ${req.url} failed: ${e && e.stack || e}`);
          if (!res.headersSent) json(res, status, { error: status === 500 ? 'internal error' : e.message }); else res.end();
        });
      });
      srv.once('error', reject);
      srv.listen(port, '0.0.0.0', () => { srv.removeListener('error', reject); server = srv; resolve(srv.address().port); });
    });
    return preferredPort ? listen(preferredPort).catch(() => listen(0)) : listen(0);
  }
  // Drops open event streams: after a new token, a phone still holding the old one must not keep listening.
  function dropStreams() { for (const s of [...streams]) { try { s.res.end(); } catch {} s.close(); } }
  function stop() {
    dropStreams();
    return new Promise((resolve) => { if (!server) return resolve(); server.close(() => resolve()); server.closeAllConnections?.(); server = null; });
  }
  const port = () => (server && server.address() ? server.address().port : 0);
  return { start, stop, port, dropStreams };
}

module.exports = { createMobileServer, lanAddresses, pairUrl, qrSvg, MOBILE_TOOLS, MOBILE_EVENTS, MOBILE_DEFAULT_PORT };
