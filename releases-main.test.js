// Run: node releases-main.test.js — persist() debounce + identical-write skip + flush() (the cadence itself is releasePeriods, releases-core.test.js)
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'overlord-rel-'));
const file = path.join(stateDir, 'releases.json');
let writes = 0;
const realWrite = fs.writeFileSync;
fs.writeFileSync = (p, ...rest) => { if (p === file) writes++; return realWrite(p, ...rest); };

const never = async () => ({ error: 'offline' });
const releases = require('./releases-main')({ send: () => {}, ghJson: never, ghGraphql: never, stateDir, whoami: async () => ({ github: null, clickup: null }) });
const wait = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  releases.handle({ type: 'releasesClearRun' }); // persist()
  releases.handle({ type: 'releasesClearRun' }); // persist() again, same burst
  assert.strictEqual(writes, 0, 'trailing debounce: nothing written yet');
  await wait(2300);
  assert.strictEqual(writes, 1, 'one write per burst');
  assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf-8')).cache.releaseRun, null);

  releases.handle({ type: 'releasesClearRun' }); // same state → same JSON
  await wait(2300);
  assert.strictEqual(writes, 1, 'identical content is not rewritten');

  releases.handle({ type: 'releasesSetSource', source: 'o/r:cfg/releases.json' }); // changes state.source; its refresh fails offline
  releases.flush();
  assert.strictEqual(writes, 2, 'flush() writes a pending change at once');
  assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf-8')).source, 'o/r:cfg/releases.json');
  await wait(2300);
  assert.strictEqual(writes, 3, "the set-source refresh failed offline and persisted its error (a real change), nothing else");
  assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf-8')).cache.error, 'offline');
  releases.flush();
  assert.strictEqual(writes, 3, 'flush() with nothing new is a no-op');

  fs.writeFileSync = realWrite;
  fs.rmSync(stateDir, { recursive: true, force: true });
  console.log('releases-main: all passed');
  process.exit(0); // the module's background timers are unref'd, but the failed refresh may still be settling
})().catch(e => { console.error(e); process.exit(1); });
