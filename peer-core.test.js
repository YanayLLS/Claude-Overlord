// Self-check for peer-core pure helpers. Run: node peer-core.test.js
const assert = require('assert');
const pc = require('./peer-core');

// ── Pairing code ──
const code = pc.generatePairingCode();
assert.strictEqual(code.length, 6);
assert.ok(/^\d{6}$/.test(code));
assert.strictEqual(pc.formatCode('481227'), '481-227');
assert.ok(pc.checkCode('481227', '481227'));
assert.ok(pc.checkCode('481227', '481-227')); // dashes/spaces tolerated
assert.ok(pc.checkCode('481227', ' 481 227 '));
assert.ok(!pc.checkCode('481227', '481228'));
assert.ok(!pc.checkCode('481227', ''));
assert.ok(!pc.checkCode('', ''));
assert.ok(!pc.checkCode(null, null)); // no code configured → nothing matches

// ── sanitizePeerName ──
assert.strictEqual(pc.sanitizePeerName('daniel-pc'), 'daniel-pc');
assert.strictEqual(pc.sanitizePeerName('DESKTOP-ABC123.local'), 'DESKTOP-ABC123.local');
assert.strictEqual(pc.sanitizePeerName('has spaces!'), 'hasspaces');
assert.strictEqual(pc.sanitizePeerName('---'), null); // must start alphanumeric
assert.strictEqual(pc.sanitizePeerName(''), null);

// ── normalizePeer ──
let r = pc.normalizePeer({ host: '192.168.1.42:7778', code: '481-227' });
assert.deepStrictEqual(r, { ok: true, peer: { host: '192.168.1.42', port: 7778, code: '481227', name: null } });
r = pc.normalizePeer({ host: 'http://daniel-pc:7779/', code: '123456' });
assert.strictEqual(r.peer.host, 'daniel-pc');
assert.strictEqual(r.peer.port, 7779);
r = pc.normalizePeer({ host: 'daniel-pc', code: '123456' }); // default port
assert.strictEqual(r.peer.port, 7778);
assert.strictEqual(pc.normalizePeer({ host: '', code: '123456' }).ok, false);
assert.strictEqual(pc.normalizePeer({ host: 'x', code: '12345' }).ok, false); // short code
assert.strictEqual(pc.normalizePeer({ host: 'x', code: '' }).ok, false);

// ── parseRemoteMentions ──
const peers = ['daniel-pc', 'Dana-Laptop'];
let ms = pc.parseRemoteMentions('@Backend@daniel-pc can you expose the endpoint?', peers);
assert.strictEqual(ms.length, 1);
assert.deepStrictEqual(ms[0], { agentName: 'Backend', peerName: 'daniel-pc', raw: '@Backend@daniel-pc' });
// case-insensitive peer match returns canonical name
ms = pc.parseRemoteMentions('ping @Api@DANA-laptop', peers);
assert.strictEqual(ms[0].peerName, 'Dana-Laptop');
// unknown peer → no match (protects emails and misc @x@y text)
assert.strictEqual(pc.parseRemoteMentions('@Backend@unknown-host hi', peers).length, 0);
assert.strictEqual(pc.parseRemoteMentions('mail me@you@example.com', peers).length, 0);
// plain local mention → no match
assert.strictEqual(pc.parseRemoteMentions('@Backend do the thing', peers).length, 0);
// dedupe repeated mentions
ms = pc.parseRemoteMentions('@Backend@daniel-pc and again @backend@daniel-pc', peers);
assert.strictEqual(ms.length, 1);
// two distinct targets
ms = pc.parseRemoteMentions('@Backend@daniel-pc @Api@Dana-Laptop', peers);
assert.strictEqual(ms.length, 2);
// no peers connected → nothing matches
assert.strictEqual(pc.parseRemoteMentions('@Backend@daniel-pc hi', []).length, 0);

// ── stripRemoteMentions ──
assert.strictEqual(
  pc.stripRemoteMentions('@Backend@daniel-pc please check @Frontend too', peers),
  ' please check @Frontend too'); // remote token gone, local mention preserved
assert.strictEqual(pc.stripRemoteMentions('no mentions here', peers), 'no mentions here');

// ── Envelopes ──
const env = pc.buildEnvelope({ toAgent: 'Backend', fromAgent: 'Frontend', fromPeer: 'marcelo-pc', fromUser: 'marcelo', text: 'hello', hop: 0 });
assert.strictEqual(env.type, 'peerMessage');
assert.ok(env.id.length >= 32);
assert.deepStrictEqual(pc.validateEnvelope(env), { ok: true });
// text cap enforced on build
const big = pc.buildEnvelope({ toAgent: 'A', fromPeer: 'p', text: 'x'.repeat(pc.MAX_TEXT_LEN + 500) });
assert.strictEqual(big.text.length, pc.MAX_TEXT_LEN);
// validation rejections
assert.ok(!pc.validateEnvelope(null).ok);
assert.ok(!pc.validateEnvelope({ ...env, toAgent: 'bad name!' }).ok);
assert.ok(!pc.validateEnvelope({ ...env, toAgent: '' }).ok);
assert.ok(!pc.validateEnvelope({ ...env, fromPeer: '' }).ok);
assert.ok(!pc.validateEnvelope({ ...env, text: '   ' }).ok);
assert.ok(!pc.validateEnvelope({ ...env, text: 'x'.repeat(pc.MAX_TEXT_LEN + 1) }).ok);
assert.ok(!pc.validateEnvelope({ ...env, hop: pc.MAX_HOP }).ok); // at the cap → refused
assert.ok(!pc.validateEnvelope({ ...env, hop: -1 }).ok);
assert.ok(!pc.validateEnvelope({ ...env, hop: 1.5 }).ok);
assert.ok(!pc.validateEnvelope({ ...env, id: '' }).ok);
// fromAgent may be empty (human-typed message from the picker modal)
assert.ok(pc.validateEnvelope({ ...env, fromAgent: '' }).ok);

// ── buildPeerHeader ──
let h = pc.buildPeerHeader(env);
assert.ok(h.startsWith('[Peer message from marcelo on marcelo-pc, agent Frontend]\nhello'));
assert.ok(h.includes('PEER-REPLY:'), 'header teaches the agent the reply marker');
// the header itself must never contain @tokens — Claude Code's teams mode
// intercepts @mentions as teammate DMs and swallows the submission
assert.ok(!h.includes('@'), 'header must not contain @ tokens (teams DM interception)');
// control chars from a peer are stripped (no escape-sequence smuggling)
h = pc.buildPeerHeader({ ...env, text: 'evil\x1b[2Jtext\x07', fromUser: 'a\x1bb' });
assert.ok(!h.includes('\x1b'));
assert.ok(!h.includes('\x07'));
assert.ok(h.includes('evil[2Jtext'));
// newlines in the message survive (auto-submitted, so multi-line is fine)
h = pc.buildPeerHeader({ ...env, text: 'line1\nline2' });
assert.ok(h.includes('line1\nline2'));
// no fromAgent → no reply offer (nowhere to route back), still well-formed
h = pc.buildPeerHeader({ ...env, fromAgent: '' });
assert.strictEqual(h, '[Peer message from marcelo on marcelo-pc]\nhello');
assert.ok(!h.includes('PEER-REPLY'));
// no user either → sender shown as the peer machine
h = pc.buildPeerHeader({ ...env, fromAgent: '', fromUser: '' });
assert.strictEqual(h, '[Peer message from marcelo-pc on marcelo-pc]\nhello');

// ── Chat messages ──
const cm = pc.buildChatMsg({ text: 'hey, is the endpoint up?' });
assert.strictEqual(cm.type, 'peerChat');
assert.ok(cm.id && typeof cm.ts === 'number');
assert.deepStrictEqual(pc.validateChatMsg(cm), { ok: true });
// text cap enforced on build
assert.strictEqual(pc.buildChatMsg({ text: 'x'.repeat(pc.CHAT_TEXT_MAX + 99) }).text.length, pc.CHAT_TEXT_MAX);
// rejections
assert.ok(!pc.validateChatMsg(null).ok);
assert.ok(!pc.validateChatMsg({ ...cm, text: '   ' }).ok); // whitespace-only
assert.ok(!pc.validateChatMsg({ ...cm, text: undefined }).ok); // no text, no file
assert.ok(!pc.validateChatMsg({ ...cm, text: 'x'.repeat(pc.CHAT_TEXT_MAX + 1) }).ok);
assert.ok(!pc.validateChatMsg({ ...cm, id: '' }).ok);
// file messages
const fm = pc.buildChatMsg({ file: { name: 'spec.pdf', size: 12345, fileId: 'f1' } });
assert.deepStrictEqual(pc.validateChatMsg(fm), { ok: true });
assert.ok(!pc.validateChatMsg({ ...fm, file: { ...fm.file, size: pc.FILE_MAX_BYTES + 1 } }).ok);
assert.ok(!pc.validateChatMsg({ ...fm, file: { ...fm.file, size: 0 } }).ok);
assert.ok(!pc.validateChatMsg({ ...fm, file: { ...fm.file, name: '' } }).ok);
// group refs
const g = { id: 'g1', name: 'backend crew', members: ['Marcelo', 'Yoav', 'dana-pc'] };
assert.deepStrictEqual(pc.validateChatMsg({ ...cm, group: g }), { ok: true });
assert.ok(!pc.validateChatMsg({ ...cm, group: { ...g, members: ['onlyone'] } }).ok); // <2 members
assert.ok(!pc.validateChatMsg({ ...cm, group: { ...g, members: ['ok', 'bad name!'] } }).ok);
assert.ok(!pc.validateChatMsg({ ...cm, group: { ...g, name: '' } }).ok);
assert.ok(pc.validateGroupRef(g));
assert.ok(!pc.validateGroupRef({ ...g, id: '' }));

// ── parsePeerSendMarker ──
let ps = pc.parsePeerSendMarker('Here is my summary.\nPEER-SEND Zephyr@me: check these findings');
assert.deepStrictEqual(ps, { agentName: 'Zephyr', target: 'me', text: 'check these findings' });
// multi-line body runs to the end of the block; "to" and leading @ optional
ps = pc.parsePeerSendMarker('PEER-SEND to @Koda@Yoav: hello there\nsecond line of the message');
assert.deepStrictEqual(ps, { agentName: 'Koda', target: 'Yoav', text: 'hello there\nsecond line of the message' });
assert.strictEqual(pc.parsePeerSendMarker('no marker here'), null);
assert.strictEqual(pc.parsePeerSendMarker('PEER-SEND Zephyr@me:   '), null); // empty body
assert.strictEqual(pc.parsePeerSendMarker('PEER-SEND Bad name@x: hi'), null); // malformed name
// body capped at MAX_TEXT_LEN
ps = pc.parsePeerSendMarker('PEER-SEND A@me: ' + 'x'.repeat(pc.MAX_TEXT_LEN + 500));
assert.strictEqual(ps.text.length, pc.MAX_TEXT_LEN);

// ── sanitizeFileName ──
assert.strictEqual(pc.sanitizeFileName('report.pdf'), 'report.pdf');
assert.strictEqual(pc.sanitizeFileName('..\\..\\windows\\evil.exe'), 'evil.exe');
assert.strictEqual(pc.sanitizeFileName('/etc/passwd'), 'passwd');
assert.strictEqual(pc.sanitizeFileName('.hidden'), '_hidden');
assert.strictEqual(pc.sanitizeFileName('a<b>:c|d?.txt'), 'a_b__c_d_.txt');
assert.strictEqual(pc.sanitizeFileName(''), 'file');
assert.ok(pc.sanitizeFileName('x'.repeat(400)).length <= 150);

// ── Masked framing: roundtrip against an RFC 6455 unmasking decoder ──
function decode(buffer) {
  const opcode = buffer[0] & 0x0f;
  const masked = (buffer[1] & 0x80) !== 0;
  let payloadLen = buffer[1] & 0x7f;
  let offset = 2;
  if (payloadLen === 126) { payloadLen = buffer.readUInt16BE(2); offset = 4; }
  else if (payloadLen === 127) { payloadLen = Number(buffer.readUInt32BE(6)); offset = 10; }
  const maskLen = masked ? 4 : 0;
  let payload;
  if (masked) {
    const mask = buffer.slice(offset, offset + 4);
    payload = Buffer.alloc(payloadLen);
    for (let i = 0; i < payloadLen; i++) payload[i] = buffer[offset + 4 + i] ^ mask[i % 4];
  } else payload = buffer.slice(offset, offset + payloadLen);
  return { opcode, masked, data: payload.toString('utf8'), totalLen: offset + maskLen + payloadLen };
}
for (const text of ['hi', JSON.stringify(env), 'x'.repeat(200), 'y'.repeat(70000), 'ünïcødé ✉']) {
  const frame = pc.wsEncodeFrameMasked(text);
  const d = decode(frame);
  assert.strictEqual(d.opcode, 0x1);
  assert.strictEqual(d.masked, true, 'client frames must be masked');
  assert.strictEqual(d.data, text);
  assert.strictEqual(d.totalLen, frame.length);
}
const ping = pc.wsEncodePingMasked();
assert.strictEqual(decode(ping).opcode, 0x9);
assert.strictEqual(decode(ping).masked, true);

// ── WS handshake accept ──
const key = pc.makeWsKey();
assert.ok(pc.checkWsAccept(key, pc.expectedWsAccept(key)));
assert.ok(!pc.checkWsAccept(key, 'nope'));
// known RFC 6455 example vector
assert.strictEqual(pc.expectedWsAccept('dGhlIHNhbXBsZSBub25jZQ=='), 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=');

console.log('peer-core: all tests passed');
