// Run: node flag-release.test.js
const assert = require('assert');
const { createFlagRelease, summarize, sameSummary, prLine, outcome } = require('./flag-release');

(async () => {
  const calls = [];
  const replies = {
    getFlagReleaseSource: { code: 1, data: JSON.stringify({ docs: [{ Key: 'IsA' }, { Key: 'IsB' }] }) },
    previewFlagRelease: { code: 1, data: JSON.stringify({ new: ['IsA'], changed: [{ key: 'IsB', fields: ['DefaultValue'] }], unchanged: [], blocked: [], fingerprint: 'fp' }) },
    applyFlagRelease: { code: 1, data: JSON.stringify({ written: ['IsA'], failed: [{ key: 'IsB', message: 'no' }], blocked: [], backup: { kinds: ['featureFlags'] } }) },
    markFlagsReleased: { code: 1, data: JSON.stringify({ written: ['IsA'], failed: [] }) },
  };
  const fetch = async (url, init) => {
    const name = url.split('/api/')[1];
    calls.push({ host: url.split('/api/')[0], name, auth: init.headers.Authorization, body: JSON.parse(init.body || '{}') });
    return { ok: true, status: 200, json: async () => replies[name] };
  };
  const fr = createFlagRelease({ fetch, tokens: () => ({ dev: 'flt_dev', prod: 'flt_prod' }) });

  // preview: dev hands out the docs, prod diffs them; each side with its own token
  const p = await fr.preview();
  assert.deepStrictEqual(calls.map(c => [c.name, c.auth]), [['getFlagReleaseSource', 'Bearer flt_dev'], ['previewFlagRelease', 'Bearer flt_prod']]);
  assert.deepStrictEqual(calls[1].body.docs.map(d => d.Key), ['IsA', 'IsB']);
  assert.deepStrictEqual(summarize(p), { new: ['IsA'], changed: [{ key: 'IsB', fields: ['DefaultValue'] }], blocked: [] });
  assert.ok(calls[0].host.includes('dev') && !calls[1].host.includes('dev'));

  // apply: prod writes against the preview's fingerprint, then dev marks only what landed Released
  calls.length = 0;
  const r = await fr.apply(p);
  assert.deepStrictEqual(calls.map(c => c.name), ['applyFlagRelease', 'markFlagsReleased']);
  assert.strictEqual(calls[0].body.expect, 'fp');
  assert.deepStrictEqual(calls[1].body.keys, ['IsA']);
  assert.deepStrictEqual(r.written, ['IsA']);

  // nothing written on prod: dev is not touched
  replies.applyFlagRelease = { code: 1, data: JSON.stringify({ written: [], failed: [], blocked: [], backup: {} }) };
  calls.length = 0;
  await fr.apply(p);
  assert.deepStrictEqual(calls.map(c => c.name), ['applyFlagRelease']);

  // a refusal from back-office (message) or the token scope (error) is thrown with its words
  replies.applyFlagRelease = { code: 2, message: 'Prod flags changed since the preview. Preview again before applying.' };
  await assert.rejects(fr.apply(p), /changed since the preview/);
  const denied = createFlagRelease({ fetch: async () => ({ ok: false, status: 403, json: async () => ({ error: 'This API token does not grant access to this endpoint' }) }), tokens: () => ({ dev: 'a', prod: 'b' }) });
  await assert.rejects(denied.preview(), /does not grant access/);

  // no tokens: a state, not an error
  const none = createFlagRelease({ fetch, tokens: () => ({}) });
  assert.deepStrictEqual(await none.preview(), { needsTokens: true });

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
  assert.strictEqual(outcome({ written: [], failed: [], blocked: [] }), 'Flags: nothing to promote');

  console.log('flag-release ok');
})().catch((e) => { console.error(e); process.exit(1); });
