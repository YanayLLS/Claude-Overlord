// One-time move to the shared cookie jar: every agent used to get its own, so the logins the user already
// typed live in the old per-agent jars. Copies their cookies (newest jar last, so the latest login wins) into
// the shared one, once, so nobody logs in again after the switch.
const fs = require('fs');
const path = require('path');

function oldJars(partitionsDir) {
  let names = [];
  try { names = fs.readdirSync(partitionsDir).filter((n) => n.startsWith('overlord-agent-')); } catch { return []; }
  return names.map((n) => { let t = 0; try { t = fs.statSync(path.join(partitionsDir, n)).mtimeMs; } catch {} return { n, t }; })
    .sort((a, b) => a.t - b.t).slice(-30).map((x) => x.n); // ponytail: newest 30 jars, older ones hold stale logins
}

const cookieUrl = (c) => `${c.secure ? 'https' : 'http'}://${String(c.domain || '').replace(/^\./, '')}${c.path || '/'}`;

async function migrateJars({ session, userData, target, log = () => {} }) {
  const marker = path.join(userData, 'Partitions', 'overlord-browser.migrated');
  if (fs.existsSync(marker)) return 0;
  const to = session.fromPartition(target).cookies;
  let n = 0;
  for (const jar of oldJars(path.join(userData, 'Partitions'))) {
    let list = [];
    try { list = await session.fromPartition('persist:' + jar).cookies.get({}); } catch { continue; }
    for (const c of list) {
      const { name, value, domain, path: p, secure, httpOnly, expirationDate, sameSite } = c;
      try { await to.set({ url: cookieUrl(c), name, value, domain: c.hostOnly ? undefined : domain, path: p, secure, httpOnly, expirationDate, sameSite }); n++; } catch {}
    }
  }
  try { await to.flushStore(); } catch {}
  try { fs.mkdirSync(path.dirname(marker), { recursive: true }); fs.writeFileSync(marker, String(Date.now())); } catch {}
  log(`browser: moved ${n} cookies from the per-agent jars into the shared one`);
  return n;
}

module.exports = { migrateJars, cookieUrl, oldJars };
