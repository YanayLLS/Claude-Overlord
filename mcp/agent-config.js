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
function writeAgentSettings(id) {
  const dir = agentConfigDir(id);
  fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  const settingsPath = path.join(dir, 'settings.json');
  fs.writeFileSync(settingsPath, JSON.stringify({ permissions: { deny: DENIED_SERVERS } }, null, 2));
  return settingsPath;
}

function settingsFlags(id) {
  return ` --settings "${writeAgentSettings(id)}"`;
}

function writeAgentConfig({ id, port, token }) {
  const settingsPath = writeAgentSettings(id);
  const mcpPath = path.join(agentConfigDir(id), '.mcp.json');
  fs.writeFileSync(mcpPath, JSON.stringify(mcpConfig(port, token), null, 2));
  return { dir: agentConfigDir(id), mcpPath, settingsPath, flags: ` --mcp-config "${mcpPath}"${settingsFlags(id)}` };
}

function removeAgentConfig(id) {
  try { fs.rmSync(agentConfigDir(id), { recursive: true, force: true }); } catch {}
}

module.exports = { agentConfigDir, writeAgentConfig, writeAgentSettings, settingsFlags, removeAgentConfig };
