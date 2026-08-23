// Stateless Streamable-HTTP MCP endpoint. POST /mcp/<token> -> single JSON response.
// The token in the path is the whole identity mechanism: one agent, one browser.
const http = require('http');
const crypto = require('crypto');
const { TOOL_SCHEMAS, createDispatcher } = require('./tools');

const PROTOCOL_VERSION = '2025-06-18';
const SERVER_INFO = { name: 'overlord-browser', version: '1.0.0' };
const MAX_BODY = 1024 * 1024;

const ok = (id, result) => ({ jsonrpc: '2.0', id, result });
const err = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > MAX_BODY) { reject(new Error('body too large')); req.destroy(); }
    });
    req.on('end', () => resolve(raw));
    req.on('error', reject);
  });
}

function reply(res, status, payload) {
  if (payload === null) { res.writeHead(status); res.end(); return; }
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

async function handleRpc(msg, resolveActions, agentId) {
  const { id, method, params } = msg;
  if (method === 'initialize') {
    return ok(id, { protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: SERVER_INFO });
  }
  if (method === 'ping') return ok(id, {});
  if (method === 'tools/list') return ok(id, { tools: TOOL_SCHEMAS });
  if (method === 'tools/call') {
    const actions = resolveActions(agentId);
    if (!actions) {
      return ok(id, { content: [{ type: 'text', text: 'This agent\'s browser is unavailable.' }], isError: true });
    }
    return ok(id, await createDispatcher(actions)((params || {}).name, (params || {}).arguments || {}));
  }
  return err(id, -32601, `Method not found: ${method}`);
}

function createMcpServer({ resolveActions }) {
  const tokens = new Map(); // token -> agentId
  const byAgent = new Map(); // agentId -> token
  let server = null;

  function mintToken(agentId) {
    if (byAgent.has(agentId)) return byAgent.get(agentId);
    const token = crypto.randomUUID();
    tokens.set(token, agentId);
    byAgent.set(agentId, token);
    return token;
  }

  function revokeToken(agentId) {
    const token = byAgent.get(agentId);
    if (token) { tokens.delete(token); byAgent.delete(agentId); }
  }

  async function onRequest(req, res) {
    const token = (req.url || '').split('?')[0].replace(/^\/mcp\//, '');
    if (!tokens.has(token)) return reply(res, 404, null);
    if (req.method !== 'POST') return reply(res, 405, null);
    let msg;
    try { msg = JSON.parse(await readBody(req)); }
    catch { return reply(res, 400, err(null, -32700, 'Parse error')); }
    if (msg.id === undefined) return reply(res, 202, null); // notification
    try { reply(res, 200, await handleRpc(msg, resolveActions, tokens.get(token))); }
    catch (e) { reply(res, 200, err(msg.id, -32603, e.message || 'Internal error')); }
  }

  function start() {
    return new Promise((resolve, reject) => {
      server = http.createServer((req, res) => { onRequest(req, res).catch(() => reply(res, 500, null)); });
      server.on('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
  }

  const stop = () => new Promise((resolve) => (server ? server.close(() => resolve()) : resolve()));
  const port = () => (server && server.address() ? server.address().port : 0);

  return { start, stop, port, mintToken, revokeToken };
}

module.exports = { createMcpServer };
