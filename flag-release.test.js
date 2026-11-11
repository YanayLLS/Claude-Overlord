// Run: node flag-release.test.js
const assert = require('assert');
const { createFlagRelease, summarize, sameSummary, prLine, outcome } = require('./flag-release');

const line = (o) => `flags\tUNKNOWN STEP\t2026-11-11T10:00:00Z FLAG_RELEASE_RESULT ${Buffer.from(JSON.stringify(o)).toString('base64')}`;

// a fake `gh`: dispatch records the inputs, the run list shows the run after a poll, the log carries the result
function fakeGh({ result, conclusion = 'success', appearAfter = 1, dispatchError = null, noResult = false }) {
  const calls = [];
  let polls = 0, request = null;
  const gh = async (args) => {
    calls.push(args);
    if (args[0] === 'workflow') {
      if (dispatchError) return { error: dispatchError };
      request = args.find(a => a.startsWith('request=')).slice(8);
      return { stdout: '' };
    }
    if (args[0] === 'run' && args[1] === 'list') {
      polls++;
      const runs = polls > appearAfter ? [{ databaseId: 7, displayTitle: `flag-release x ${request}`, status: 'completed', conclusion }] : [];
      return { stdout: JSON.stringify([{ databaseId: 1, displayTitle: 'flag-release preview other', status: 'completed', conclusion: 'success' }, ...runs]) };
    }
    if (args[0] === 'run' && args[1] === 'view') return { stdout: noResult ? 'boom' : `noise\n${line(result)}\nmore` };
    throw new Error('unexpected ' + args.join(' '));
  };
  return { gh, calls };
}
const fast = { sleep: async () => {}, newId: () => 'req1' };

(async () => {
  const plan = { new: ['IsA'], changed: [{ key: 'IsB', fields: ['DefaultValue'] }], unchanged: [], blocked: [], fingerprint: 'fp' };

  // preview: dispatches the workflow on master with mode and request, then reads the run's result line
  const a = fakeGh({ result: { ok: true, result: plan } });
  const p = await createFlagRelease({ gh: a.gh, ...fast }).preview();
  assert.deepStrictEqual(a.calls[0], ['workflow', 'run', 'flag-release.yml', '-R', 'LLSLtd/back-office', '--ref', 'master', '-f', 'mode=preview', '-f', 'expect=', '-f', 'request=req1']);
  assert.deepStrictEqual(a.calls.slice(-1)[0].slice(0, 4), ['run', 'view', '7', '-R']);
  assert.deepStrictEqual(summarize(p), { new: ['IsA'], changed: [{ key: 'IsB', fields: ['DefaultValue'] }], blocked: [] });

  // apply: sends the preview's fingerprint
  const b = fakeGh({ result: { ok: true, result: { written: ['IsA'], failed: [], blocked: [], backup: {} } } });
  const r = await createFlagRelease({ gh: b.gh, ...fast }).apply(p);
  assert.ok(b.calls[0].includes('mode=apply') && b.calls[0].includes('expect=fp'));
  assert.deepStrictEqual(r.written, ['IsA']);

  // the run's own error comes back as the error
  const c = fakeGh({ result: { ok: false, error: 'applyFlagRelease: Flags changed on dev or prod since the preview.' }, conclusion: 'failure' });
  await assert.rejects(createFlagRelease({ gh: c.gh, ...fast }).apply(p), /Flags changed on dev or prod/);

  // a run that ended without a result line
  const d = fakeGh({ noResult: true, conclusion: 'cancelled' });
  await assert.rejects(createFlagRelease({ gh: d.gh, ...fast }).preview(), /flag-release run 7 ended cancelled without a result/);

  // the workflow not on master yet (before back-office ships it to prod)
  const e = fakeGh({ dispatchError: 'HTTP 404: workflow flag-release.yml not found on the default branch (https://api.github.com/repos/LLSLtd/back-office/actions/workflows/flag-release.yml)' });
  await assert.rejects(createFlagRelease({ gh: e.gh, ...fast }).preview(), /flag-release workflow is not on back-office master yet/);

  // a run that never shows up
  const f = fakeGh({ result: {}, appearAfter: 1e9 });
  let t = 0;
  await assert.rejects(createFlagRelease({ gh: f.gh, sleep: async () => {}, newId: () => 'x', now: () => (t += 60e3) }).preview(), /did not finish/);

  // the summary is what the release opened with; a different one at Release all time means re-review
  assert.ok(sameSummary(p, { ...p, fingerprint: 'other' }));
  assert.ok(!sameSummary(p, { ...p, new: ['IsA', 'IsC'] }));

  // the PR body line names every flag
  assert.strictEqual(prLine(p), '> 🚩 **Feature flags with this release:** `IsA` new · `IsB` changed (DefaultValue)\n\n');
  assert.strictEqual(prLine({ new: [], changed: [], blocked: [{ key: 'IsC', why: 'needs IsD, which prod does not have' }] }),
    '> 🚩 **Feature flags with this release:** `IsC` blocked: needs IsD, which prod does not have\n\n');
  assert.strictEqual(prLine({ new: [], changed: [], blocked: [] }), '');

  // the line a release card shows after apply
  assert.strictEqual(outcome({ written: ['IsA'], failed: [{ key: 'IsB', message: 'no' }], blocked: [] }), 'Flags: 1 promoted · IsB failed: no');
  assert.strictEqual(outcome({ written: ['IsA'], failed: [], blocked: [], markError: 'dev down' }), 'Flags: 1 promoted · dev not marked Released: dev down');
  assert.strictEqual(outcome({ written: [], failed: [], blocked: [] }), 'Flags: nothing to promote');

  console.log('flag-release ok');
})().catch((e) => { console.error(e); process.exit(1); });
