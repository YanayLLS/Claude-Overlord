// Writes the per-agent MCP + settings files the Claude CLI is launched with.
// Every spawn site in main.js goes through here so they cannot drift apart.
const fs = require('fs');
const os = require('os');
const path = require('path');

const DENIED_SERVERS = ['mcp__claude-in-chrome'];
// The token in .mcp.json is a bearer credential for this agent's browser, and
// os.tmpdir() is world-readable. 0o700 keeps it to this user. (No-op on Windows,
// where the inherited ACL already scopes it to the creating account.)
const DIR_MODE = 0o700;

function agentConfigDir(id) {
  return path.join(os.tmpdir(), 'overlord', `agent-${id}`);
}

function mcpConfig(port, token) {
  return { mcpServers: { 'overlord-browser': { type: 'http', url: `http://127.0.0.1:${port}/mcp/${token}` } } };
}

// The deny rule is the half that matters on every spawn site, including the
// detached before-quit process that outlives the MCP server's port.
// Feature agents only: before each file edit, ask Overlord (POST /hook/<token>, mcp/server.js) whether
// the file sits in a repo's main checkout; if so Overlord makes the feature's worktree there and the
// edit is denied with the path to use instead. Overlord unreachable or slow -> the edit goes through.
const EDIT_HOOK = "const [port, token] = process.argv.slice(2); let s = ''; process.stdin.on('data', (d) => { s += d; }).on('end', async () => { try {"
  + " const r = await fetch('http://127.0.0.1:' + port + '/hook/' + token, { method: 'POST', body: s, signal: AbortSignal.timeout(110000) });"
  + " const a = await r.json(); if (a && a.deny) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: a.deny } }));"
  + " } catch {} });\n";

function writeAgentSettings(id, editHook = null) {
  const dir = agentConfigDir(id);
  fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  const settingsPath = path.join(dir, 'settings.json');
  // A question's whole input (its previews) as it opens: the transcript only gets it once answered, and the CLI's screen
  // shows one preview at a time, cut to its box. The hook saves it to ask.json; main sends it to the chat's card.
  // (Written here, not run from the app folder: a packaged app's files sit inside app.asar, which node can't read.)
  const hook = path.join(dir, 'ask-hook.js'), fwd = (p) => p.replace(/\\/g, '/');
  fs.writeFileSync(hook, "let s = ''; process.stdin.on('data', (d) => { s += d; }).on('end', () => { try { require('fs').writeFileSync(process.argv[2], JSON.stringify(JSON.parse(s).tool_input || {})); } catch {} });\n");
  const hooks = { PreToolUse: [{ matcher: 'AskUserQuestion', hooks: [{ type: 'command', command: `node "${fwd(hook)}" "${fwd(askFile(id))}"`, timeout: 5 }] }] };
  if (editHook) {
    const eh = path.join(dir, 'edit-hook.js');
    fs.writeFileSync(eh, EDIT_HOOK);
    hooks.PreToolUse.push({ matcher: 'Edit|MultiEdit|Write|NotebookEdit', hooks: [{ type: 'command', command: `node "${fwd(eh)}" ${Number(editHook.port)} ${editHook.token}`, timeout: 120 }] });
  }
  fs.writeFileSync(settingsPath, JSON.stringify({ permissions: { deny: DENIED_SERVERS }, hooks }, null, 2));
  return settingsPath;
}
const askFile = (id) => path.join(agentConfigDir(id), 'ask.json');

function settingsFlags(id) {
  return ` --settings "${writeAgentSettings(id)}"`;
}

function writeAgentConfig({ id, port, token, editHook = false }) {
  const settingsPath = writeAgentSettings(id, editHook ? { port, token } : null);
  const mcpPath = path.join(agentConfigDir(id), '.mcp.json');
  fs.writeFileSync(mcpPath, JSON.stringify(mcpConfig(port, token), null, 2));
  return { dir: agentConfigDir(id), mcpPath, settingsPath, flags: ` --mcp-config "${mcpPath}" --settings "${settingsPath}"` };
}

function removeAgentConfig(id) {
  try { fs.rmSync(agentConfigDir(id), { recursive: true, force: true }); } catch {}
}

module.exports = { agentConfigDir, writeAgentConfig, writeAgentSettings, settingsFlags, removeAgentConfig, askFile };
