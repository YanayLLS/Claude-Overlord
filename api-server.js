// HTTP face of the local API (api-core.js), 127.0.0.1 only. Every request needs Authorization: Bearer <token> and a
// loopback Host header. No CORS headers: browser pages can't read responses; local programs aren't browsers.
//   GET  /v1/health            → { ok, apiVersion }                 (no token: lets a client see Overlord is up)
//   GET  /v1/tools             → the tool list with input schemas
//   POST /v1/<tool>            → tool result as JSON (body = arguments)
//   GET  /v1/events?types=a.,b → SSE stream; Last-Event-ID (or ?since=) replays what is still buffered
//   POST /mcp                  → MCP Streamable HTTP (JSON responses)
// Self-check: api-server.test.js
const http = require('http');
const { tokenOk, hostOk, parseFilter, wants, ApiError, API_VERSION } = require('./api-core');

const MAX_BODY = 4 * 1024 * 1024;

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on('data', (c) => { n += c.length; if (n > MAX_BODY) { reject(new ApiError(413, 'body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store' });
  res.end(body);
}
async function parseJson(req) {
  const raw = await readBody(req);
  if (!raw.trim()) return {};
  try { return JSON.parse(raw); } catch { throw new ApiError(400, 'body is not JSON'); }
}

// api: createApi(...) result. getToken: () => current token (it can be regenerated while running).
function createApiServer({ api, getToken, log = () => {} }) {
  let server = null;
  const streams = new Set();

  function sse(req, res, url) {
    const filter = parseFilter(url.searchParams.get('types'));
    const from = Number(req.headers['last-event-id'] || url.searchParams.get('since') || NaN);
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive' });
    const write = (ev) => res.write(`id: ${ev.seq}\nevent: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);
    res.write(`: overlord api v${API_VERSION}\nretry: 3000\n\n`);
    if (Number.isFinite(from)) for (const ev of api.since(from, filter)) write(ev);
    const off = api.subscribe((ev) => { if (wants(filter, ev.type)) write(ev); });
    const beat = setInterval(() => res.write(': ping\n\n'), 20000); // keeps idle proxies and clients from timing out
    const s = { res, close: () => { clearInterval(beat); off(); streams.delete(s); } };
    streams.add(s);
    req.on('close', s.close);
  }

  async function onRequest(req, res) {
    const port = server.address().port;
    if (!hostOk(req.headers.host, port)) return json(res, 403, { error: 'bad Host header' });
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    const p = url.pathname.replace(/\/+$/, '');
    if (req.method === 'GET' && p === '/v1/health') return json(res, 200, { ok: true, apiVersion: API_VERSION });
    if (!tokenOk(req.headers.authorization, getToken())) return json(res, 401, { error: 'missing or wrong bearer token (see ~/.overlord/api.json)' });

    if (p === '/mcp') {
      if (req.method !== 'POST') return json(res, 405, { error: 'POST only' }); // stateless: no GET stream, no sessions
      const msg = await parseJson(req);
      if (Array.isArray(msg)) return json(res, 200, await Promise.all(msg.filter(m => m && m.id !== undefined).map(m => api.mcp(m))));
      if (!msg || msg.id === undefined) { res.writeHead(202); return res.end(); } // notification
      return json(res, 200, await api.mcp(msg));
    }
    if (req.method === 'GET' && p === '/v1/events') return sse(req, res, url);
    if (req.method === 'GET' && p === '/v1/tools') return json(res, 200, { tools: api.tools });
    const m = /^\/v1\/([a-z_]+)$/.exec(p);
    if (m && req.method === 'POST') return json(res, 200, await api.call(m[1], await parseJson(req)));
    if (m && req.method === 'GET') return json(res, 405, { error: `POST /v1/${m[1]} with a JSON body` });
    return json(res, 404, { error: 'not found' });
  }

  // preferredPort first (clients may have it saved), else any free one; the caller writes the real one to api.json.
  function start(preferredPort) {
    const listen = (p) => new Promise((resolve, reject) => {
      server = http.createServer((req, res) => {
        onRequest(req, res).catch((e) => {
          const status = e instanceof ApiError ? e.status : 500;
          if (status === 500) log(`api ${req.method} ${req.url} failed: ${e && e.stack || e}`);
          if (!res.headersSent) json(res, status, { error: status === 500 ? 'internal error' : e.message }); else res.end();
        });
      });
      server.once('error', reject);
      server.listen(p, '127.0.0.1', () => { server.removeListener('error', reject); resolve(server.address().port); });
    });
    return preferredPort ? listen(preferredPort).catch(() => listen(0)) : listen(0);
  }
  function stop() {
    for (const s of [...streams]) { try { s.res.end(); } catch {} s.close(); }
    return new Promise((resolve) => { if (!server) return resolve(); server.close(() => resolve()); server.closeAllConnections?.(); server = null; });
  }
  const port = () => (server && server.address() ? server.address().port : 0);
  return { start, stop, port };
}

module.exports = { createApiServer };
