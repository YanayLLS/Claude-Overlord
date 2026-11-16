// Run: node release-history-shipped.test.js — a failed deploy counts as shipped by a later run that contains it
const assert = require('assert');
const { shippedLater } = require('./release-history');

(async () => {
  const runs = [
    { created_at: '2026-11-16T09:02:00Z', head_sha: 'later', html_url: 'run-ok', updated_at: 'u' },
    { created_at: '2026-11-16T08:00:00Z', head_sha: 'older', html_url: 'run-old', updated_at: 'u' },
  ];
  const contains = { 'm1...later': 'ahead', 'm2...later': 'diverged' };
  const gh = async (args) => {
    const a = args.join(' ');
    if (a.includes('/runs')) { assert.ok(a.includes('status=success') && a.includes('branch=release-candidate')); return { data: { workflow_runs: runs } }; }
    const m = a.match(/compare\/(\S+)$/);
    return m ? { data: { status: contains[m[1]] || 'behind' } } : { error: 'unexpected ' + a };
  };
  const failed = { created_at: '2026-11-16T08:34:00Z' };
  const r = (sha) => ({ repo: 'o/mobile', target: 'release-candidate', mergeSha: sha, deploy: { workflow: 'release-candidate.yml' } });
  // a later green run whose commit contains the merge: shipped by it
  assert.strictEqual((await shippedLater(gh, r('m1'), failed)).html_url, 'run-ok');
  // a later green run that does not contain it: still failed
  assert.strictEqual(await shippedLater(gh, r('m2'), failed), null);
  // only runs started after the failure count (the 08:00 run is older)
  assert.strictEqual(await shippedLater(gh, r('m3'), { created_at: '2026-11-16T10:00:00Z' }), null);
  console.log('release-history-shipped: ok');
})().catch(e => { console.error(e); process.exit(1); });
