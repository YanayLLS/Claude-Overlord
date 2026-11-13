// Stateless Streamable-HTTP MCP endpoint. POST /mcp/<token> -> single JSON response.
// The token in the path is the whole identity mechanism: one agent, one browser.
const http = require('http');
const crypto = require('crypto');
const { TOOL_SCHEMAS, TERMINAL_SCHEMAS, VISUAL_SCHEMAS, PR_SCHEMAS, prCall, createDispatcher, terminalCall, visualCall } = require('./tools');

const PROTOCOL_VERSION = '2025-06-18';
const SERVER_INFO = { name: 'overlord-browser', version: '1.0.0' };
// Agents kept popping Chrome/Playwright windows on the user's screen: this browser opens in Overlord beside their chat.
const INSTRUCTIONS = "Your own browser inside Overlord: it opens in a pane beside your chat, where the user watches. Use it for every look at a web page (checking a UI, a localhost app, a flow) instead of opening Chrome, Edge or a headed Playwright window, which pop up on the user's screen. Whenever you check or show how something looks or behaves (a screen, a flow, a fix, a design review), do it here, step by step with browser_navigate / browser_click / browser_type / browser_screenshot, so the user sees you work: a headless Playwright script is invisible to them. Headless Playwright is for automated test suites and bulk screenshot runs only (never headless: false). Never open URLs with start/Start-Process/explorer. Never ask the user to do something to the pane: for the desktop (or phone) layout in a pane of any size call browser_viewport, and when you are done with a page (a test or check finished) call browser_close so the pane does not stay open beside the chat; and never ask the user to log in: logins are kept for every agent and across restarts, and a username and password typed once in this browser is filled in on that site's login page by itself (wait a second on a login page before acting). If a login page still sits there, log in yourself with browser_type when you know the credentials. Ask only for what you cannot get yourself, like a password you do not have. Dev servers started by scripts like start-full.bat run in Overlord's Terminals pane: read their output with terminal_list / terminal_read (and terminal_restart) to debug a local server. Whenever a visual explains better than prose (a UI mockup, a diagram, a chart, a comparison), show it in the chat with show_visual: self-contained HTML/SVG with inline CSS/JS and no network, and variants when there are alternatives to choose from.";
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

async function handleRpc(msg, resolveActions, agentId, getTerminals, prClaims) {
  const { id, method, params } = msg;
  if (method === 'initialize') {
    return ok(id, { protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: SERVER_INFO, instructions: INSTRUCTIONS });
  }
  if (method === 'ping') return ok(id, {});
  if (method === 'tools/list') return ok(id, { tools: [...TOOL_SCHEMAS, ...TERMINAL_SCHEMAS, ...VISUAL_SCHEMAS, ...PR_SCHEMAS] });
  if (method === 'tools/call') {
    const name = (params || {}).name || '';
    if (name === 'show_visual') return ok(id, visualCall((params || {}).arguments || {})); // drawn by the chat from the call itself
    if (name.startsWith('pr_')) return ok(id, prCall(prClaims, agentId, name, (params || {}).arguments || {}));
    if (name.startsWith('terminal_')) return ok(id, terminalCall(getTerminals(), name, (params || {}).arguments || {}));
    const actions = resolveActions(agentId);
    if (!actions) {
      return ok(id, { content: [{ type: 'text', text: 'This agent\'s browser is unavailable.' }], isError: true });
    }
    return ok(id, await createDispatcher(actions)((params || {}).name, (params || {}).arguments || {}));
  }
  return err(id, -32601, `Method not found: ${method}`);
}

function createMcpServer({ resolveActions, getTerminals = () => null, prClaims = null }) {
  const tokens = new Map(); // token -> agentId
  const byAgent = new Map(); // agentId -> token
  let server = null;

  // reuse: the token an agent that survived an app restart still has in its MCP config.
  function mintToken(agentId, reuse) {
    if (byAgent.has(agentId)) return byAgent.get(agentId);
    const token = reuse || crypto.randomUUID();
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
    try { reply(res, 200, await handleRpc(msg, resolveActions, tokens.get(token), getTerminals, prClaims)); }
    catch (e) { reply(res, 200, err(msg.id, -32603, e.message || 'Internal error')); }
  }

  // preferredPort: last launch's port, so agents that survived a restart can still reach us.
  function start(preferredPort) {
    const listen = (p) => new Promise((resolve, reject) => {
      server = http.createServer((req, res) => { onRequest(req, res).catch(() => reply(res, 500, null)); });
      server.once('error', reject);
      server.listen(p, '127.0.0.1', resolve);
    });
    return preferredPort ? listen(preferredPort).catch(() => listen(0)) : listen(0);
  }

  const stop = () => new Promise((resolve) => (server ? server.close(() => resolve()) : resolve()));
  const port = () => (server && server.address() ? server.address().port : 0);

  return { start, stop, port, mintToken, revokeToken };
}

module.exports = { createMcpServer };
