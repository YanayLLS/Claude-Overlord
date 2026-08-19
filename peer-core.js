// Pure helpers for LAN peers (Overlord ↔ Overlord messaging). Shared by main.js
// and the node self-check in peer-core.test.js. No sockets, no fs — strings,
// buffers, and message envelopes only.

const crypto = require('crypto');

const MAX_HOP = 4; // envelope hop ceiling — auto-relay (future) must stop here
const MAX_TEXT_LEN = 16000;
const PEER_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const AGENT_NAME_RE = /^[A-Za-z][A-Za-z0-9]{0,63}$/;

// ── Pairing code ──
function generatePairingCode() {
  // 6 digits from a CSPRNG; stored/compared as a plain digit string
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}
function normalizeCode(c) { return String(c || '').replace(/\D/g, ''); }
function formatCode(c) { const n = normalizeCode(c); return n.length === 6 ? n.slice(0, 3) + '-' + n.slice(3) : n; }
function checkCode(expected, given) {
  const a = normalizeCode(expected), b = normalizeCode(given);
  if (!a || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

// Sanitize a hostname/user-typed name into a valid peer name (or null).
function sanitizePeerName(name) {
  const s = String(name || '').replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 64);
  return PEER_NAME_RE.test(s) ? s : null;
}

// ── Peer config ──
// Accepts { host: 'host', port } or a combined 'host:port' in host. Code required.
function normalizePeer({ host, port, code, name }) {
  let h = String(host || '').trim().replace(/^[a-z]+:\/\//i, '').replace(/\/.*$/, '');
  const m = h.match(/^(.+):(\d+)$/);
  if (m) { h = m[1]; port = m[2]; }
  h = h.replace(/[^A-Za-z0-9_.:-]/g, ''); // allow IPv4/hostname; ':' only survives via [::1] style (rare, harmless)
  const p = parseInt(port, 10) || 7778;
  if (!h) return { ok: false, error: 'Missing host' };
  if (p < 1 || p > 65535) return { ok: false, error: 'Bad port' };
  const c = normalizeCode(code);
  if (c.length !== 6) return { ok: false, error: 'Pairing code must be 6 digits' };
  return { ok: true, peer: { host: h, port: p, code: c, name: sanitizePeerName(name) || null } };
}

// ── Remote mentions: @AgentName@peerName ──
// Only names present in peerNames match, so emails/decorators never trigger.
const REMOTE_MENTION_RE = /@([A-Za-z][A-Za-z0-9]*)@([A-Za-z0-9][A-Za-z0-9_.-]*)/g;

function parseRemoteMentions(text, peerNames) {
  const byLower = new Map();
  for (const n of peerNames || []) byLower.set(String(n).toLowerCase(), n);
  const found = [];
  const seen = new Set();
  let m;
  REMOTE_MENTION_RE.lastIndex = 0;
  while ((m = REMOTE_MENTION_RE.exec(text)) !== null) {
    const canon = byLower.get(m[2].toLowerCase());
    if (!canon) continue;
    const key = (m[1] + '@' + canon).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    found.push({ agentName: m[1], peerName: canon, raw: m[0] });
  }
  return found;
}

// Remove remote-mention tokens so the local @mention scanner doesn't also fire
// on the '@AgentName' prefix of '@AgentName@peer'.
function stripRemoteMentions(text, peerNames) {
  const mentions = parseRemoteMentions(text, peerNames);
  let out = text;
  for (const mn of mentions) out = out.split(mn.raw).join('');
  return out;
}

// ── Message envelopes ──
function buildEnvelope({ toAgent, fromAgent, fromPeer, fromUser, text, hop }) {
  return {
    type: 'peerMessage',
    id: crypto.randomUUID(),
    toAgent: String(toAgent || ''),
    fromAgent: String(fromAgent || ''),
    fromPeer: String(fromPeer || ''),
    fromUser: String(fromUser || ''),
    text: String(text || '').slice(0, MAX_TEXT_LEN),
    hop: Math.max(0, Math.min(MAX_HOP, Number(hop) || 0)),
  };
}

function validateEnvelope(m) {
  if (!m || typeof m !== 'object') return { ok: false, error: 'not an object' };
  if (typeof m.id !== 'string' || !m.id || m.id.length > 64) return { ok: false, error: 'bad id' };
  if (!AGENT_NAME_RE.test(m.toAgent || '')) return { ok: false, error: 'bad toAgent' };
  if (m.fromAgent && !AGENT_NAME_RE.test(m.fromAgent)) return { ok: false, error: 'bad fromAgent' };
  if (!PEER_NAME_RE.test(m.fromPeer || '')) return { ok: false, error: 'bad fromPeer' };
  if (typeof m.text !== 'string' || !m.text.trim()) return { ok: false, error: 'empty text' };
  if (m.text.length > MAX_TEXT_LEN) return { ok: false, error: 'text too long' };
  const hop = Number(m.hop);
  if (!Number.isInteger(hop) || hop < 0) return { ok: false, error: 'bad hop' };
  if (hop >= MAX_HOP) return { ok: false, error: 'hop limit reached' };
  return { ok: true };
}

// Prompt handed straight to the receiving agent (pasted and auto-submitted).
// Kept minimal: one context line naming the sender and the return address,
// then the message. Control chars are stripped so a malicious peer can't
// smuggle escape sequences into the terminal; newlines survive (bracketed
// paste keeps them from submitting early).
// IMPORTANT: the delivered text must contain no @name tokens — Overlord runs
// Claude Code with agent teams enabled, and the TUI intercepts submissions
// containing @mentions as teammate DMs ("to must be a bare teammate name"),
// swallowing the message before it reaches the model.
function cleanText(s) { return String(s).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, ''); }
function buildPeerHeader(env) {
  const who = cleanText(env.fromUser || env.fromPeer);
  const agent = env.fromAgent ? `, agent ${cleanText(env.fromAgent)}` : '';
  return `[Peer message from ${who} on ${cleanText(env.fromPeer)}${agent}]\n${cleanText(env.text)}`;
}

// ── WebSocket client-side framing ──
// RFC 6455: client→server frames MUST be masked (the in-repo wsEncodeFrame is
// the server-side, unmasked variant). Server→client frames arrive unmasked,
// which the in-repo wsDecodeFrame already tolerates.
function wsEncodeFrameMasked(text, opcode = 0x1) {
  const data = Buffer.from(String(text), 'utf8');
  const len = data.length;
  let header;
  if (len < 126) { header = Buffer.alloc(2); header[1] = 0x80 | len; }
  else if (len < 65536) { header = Buffer.alloc(4); header[1] = 0x80 | 126; header.writeUInt16BE(len, 2); }
  else { header = Buffer.alloc(10); header[1] = 0x80 | 127; header.writeUInt32BE(0, 2); header.writeUInt32BE(len, 6); }
  header[0] = 0x80 | (opcode & 0x0f);
  const mask = crypto.randomBytes(4);
  const masked = Buffer.alloc(len);
  for (let i = 0; i < len; i++) masked[i] = data[i] ^ mask[i % 4];
  return Buffer.concat([header, mask, masked]);
}
function wsEncodePingMasked() { return wsEncodeFrameMasked('', 0x9); }

// ── WebSocket client handshake ──
function makeWsKey() { return crypto.randomBytes(16).toString('base64'); }
function expectedWsAccept(key) {
  return crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
}
function checkWsAccept(key, acceptHeader) { return expectedWsAccept(key) === String(acceptHeader || '').trim(); }

module.exports = {
  MAX_HOP, MAX_TEXT_LEN,
  generatePairingCode, normalizeCode, formatCode, checkCode,
  sanitizePeerName, normalizePeer,
  parseRemoteMentions, stripRemoteMentions,
  buildEnvelope, validateEnvelope, buildPeerHeader,
  wsEncodeFrameMasked, wsEncodePingMasked,
  makeWsKey, expectedWsAccept, checkWsAccept,
};
