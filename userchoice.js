'use strict';
// Windows keeps the user's default app for a file type in FileExts\<ext>\UserChoice, signed with a
// hash so apps can't set it silently. This is the publicly documented hash (port of PS-SFTA,
// MIT, Copyright (c) 2022 Danysys) so Overlord's Settings button can set .md in one click.
// ponytail: Windows 11's UserChoiceLatest uses a newer, undocumented hash; we delete it and write
// the legacy key. If Windows stops honouring that, associate() falls back to the Settings page.
const crypto = require('crypto');
const fs = require('fs');

const EXPERIENCE = 'User Choice set via Windows User Experience {D18B6DD5-6124-4341-9318-804003BAFA0B}';

const i32 = (v) => BigInt.asIntN(32, BigInt(v));
const long = (buf, i = 0) => BigInt(buf.readInt32LE(i));
const shr = (v, n) => (v & 0x80000000n) ? ((v >> BigInt(n)) ^ 0xFFFF0000n) : (v >> BigInt(n));

function hash(baseInfo) {
  const data = Buffer.concat([Buffer.from(baseInfo, 'utf16le'), Buffer.alloc(2)]);
  const md5 = crypto.createHash('md5').update(data).digest();
  const lengthBase = BigInt(baseInfo.length * 2 + 2);
  const length = ((lengthBase & 4n) <= 1n ? 1n : 0n) + shr(lengthBase, 2) - 1n;
  if (length <= 1n) return '';
  const rd = (p) => (p + 4 <= data.length ? long(data, p) : 0n);
  const count = Number(shr(length - 2n, 1)) + 1;
  const out = Buffer.alloc(16);

  let p = 0, cache = 0n, h1 = 0n, h2 = 0n;
  let m1 = (long(md5) | 1n) + 0x69FB0000n, m2 = (long(md5, 4) | 1n) + 0x13DB0000n;
  for (let c = count; c; c--) {
    const r0 = i32(rd(p) + h1), r1 = i32(rd(p + 4)); p += 8;
    const r2a = i32(r0 * m1 - 0x10FA9605n * shr(r0, 16));
    const r2b = i32(0x79F8A395n * r2a + 0x689B6B9Fn * shr(r2a, 16));
    const r3 = i32(0xEA970001n * r2b - 0x3C101569n * shr(r2b, 16));
    const r4 = i32(r3 + r1), r5 = i32(cache + r3);
    const r6a = i32(r4 * m2 - 0x3CE8EC25n * shr(r4, 16));
    const r6b = i32(0x59C3AF2Dn * r6a - 0x2232E0F1n * shr(r6a, 16));
    h1 = i32(0x1EC90001n * r6b + 0x35BD1EC9n * shr(r6b, 16));
    h2 = i32(r5 + h1); cache = h2;
  }
  out.writeInt32LE(Number(h1), 0); out.writeInt32LE(Number(h2), 4);

  p = 0; cache = 0n; h1 = 0n; h2 = 0n;
  m1 = long(md5) | 1n; m2 = long(md5, 4) | 1n;
  for (let c = count; c; c--) {
    const r0 = i32(rd(p) + h1); p += 8;
    const r1a = i32(r0 * m1);
    const r1b = i32(0xB1110000n * r1a - 0x30674EEFn * shr(r1a, 16));
    const r2a = i32(0x5B9F0000n * r1b - 0x78F7A461n * shr(r1b, 16));
    const r2b = i32(0x12CEB96Dn * shr(r2a, 16) - 0x46930000n * r2a);
    const r3 = i32(0x1D830000n * r2b + 0x257E1D83n * shr(r2b, 16));
    const r4a = i32(m2 * (r3 + rd(p - 4)));
    const r4b = i32(0x16F50000n * r4a - 0x5D8BE90Bn * shr(r4a, 16));
    const r5a = i32(0x96FF0000n * r4b - 0x2C7C6901n * shr(r4b, 16));
    const r5b = i32(0x2B890000n * r5a + 0x7C932B89n * shr(r5a, 16));
    h1 = i32(0x9F690000n * r5b - 0x405B6097n * shr(r5b, 16));
    h2 = i32(h1 + cache + r3); cache = h2;
  }
  out.writeInt32LE(Number(h1), 8); out.writeInt32LE(Number(h2), 12);

  const res = Buffer.alloc(8);
  res.writeInt32LE(out.readInt32LE(8) ^ out.readInt32LE(0), 0);
  res.writeInt32LE(out.readInt32LE(12) ^ out.readInt32LE(4), 4);
  return res.toString('base64');
}

// The minute Windows stamps the key with, as the 16-hex-digit FILETIME the hash expects.
function hexMinute(d = new Date()) {
  const m = new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), 0);
  return ((BigInt(m.getTime()) + 11644473600000n) * 10000n).toString(16).padStart(16, '0');
}

function experience(shell32 = (process.env.SystemRoot || 'C:\\Windows') + '\\SysWOW64\\shell32.dll') {
  try {
    const s = fs.readFileSync(shell32).subarray(0, 5 * 1024 * 1024).toString('utf16le');
    const a = s.indexOf('User Choice set via Windows User Experience'); const b = s.indexOf('}', a);
    if (a >= 0 && b > a) return s.slice(a, b + 1);
  } catch {}
  return EXPERIENCE;
}

const userChoiceHash = (ext, sid, progId, when = new Date(), exp = EXPERIENCE) =>
  hash(`${ext}${sid}${progId}${hexMinute(when)}${exp}`.toLowerCase());

module.exports = { hash, hexMinute, experience, userChoiceHash };
