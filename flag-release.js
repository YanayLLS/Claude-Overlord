// Feature flags travel with a prod release: the flags marked Ready for release on dev's back office
// are previewed against prod when the release opens, and applied once Release all has deployed prod.
// Back-office owns the rules (what travels, what prod keeps, what is blocked: flagReleaseLogic.js);
// this only calls it, with the releaser's own API tokens (scope "Feature flag releases"), so prod's
// activity log names the person who released.

const SOURCE = 'https://backoffice.dev.frontline.io';
const TARGET = 'https://backoffice.frontline.io';

function createFlagRelease({ fetch, tokens }) {
  async function call(base, token, name, body = {}) {
    const res = await fetch(`${base}/api/${name}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => null);
    const why = json && (json.message || json.error);
    if (why || !res.ok || !json || !json.data) throw new Error(why || `${name}: HTTP ${res.status}`);
    return JSON.parse(json.data);
  }

  async function preview() {
    const t = tokens() || {};
    if (!t.dev || !t.prod) return { needsTokens: true };
    const { docs } = await call(SOURCE, t.dev, 'getFlagReleaseSource');
    const plan = await call(TARGET, t.prod, 'previewFlagRelease', { docs });
    return { ...plan, docs };
  }

  // A failure halfway leaves the first half written: applying the same preview again finishes it.
  async function apply(p) {
    const t = tokens() || {};
    const result = await call(TARGET, t.prod, 'applyFlagRelease', { docs: p.docs, expect: p.fingerprint });
    // prod is written now: a dev failure is reported, never thrown (it would read as "not promoted").
    // Unchanged flags already match prod, so they are shipped too; marking them is what a retry finishes.
    const keys = [...result.written, ...(p.unchanged || [])];
    if (keys.length) await call(SOURCE, t.dev, 'markFlagsReleased', { keys }).catch((e) => { result.markError = e.message; });
    return result;
  }

  return { preview, apply };
}

const summarize = p => ({ new: p.new || [], changed: p.changed || [], blocked: p.blocked || [] });
const sameSummary = (a, b) => JSON.stringify(summarize(a)) === JSON.stringify(summarize(b));
const any = s => s.new.length + s.changed.length + s.blocked.length > 0;

function prLine(p) {
  const s = summarize(p);
  if (!any(s)) return '';
  const bits = [
    ...s.new.map(k => `\`${k}\` new`),
    ...s.changed.map(c => `\`${c.key}\` changed (${c.fields.join(', ')})`),
    ...s.blocked.map(b => `\`${b.key}\` blocked: ${b.why}`),
  ];
  return `> 🚩 **Feature flags with this release:** ${bits.join(' · ')}\n\n`;
}

function outcome(r) {
  const bits = [
    ...(r.written.length ? [`${r.written.length} promoted`] : []),
    ...r.failed.map(f => `${f.key} failed: ${f.message}`),
    ...(r.blocked || []).map(b => `${b.key} blocked: ${b.why}`),
  ];
  if (r.markError) bits.push(`dev not marked Released: ${r.markError}`);
  return `Flags: ${bits.length ? bits.join(' · ') : 'nothing to promote'}`;
}

module.exports = { createFlagRelease, summarize, sameSummary, prLine, outcome, any, SOURCE, TARGET };
