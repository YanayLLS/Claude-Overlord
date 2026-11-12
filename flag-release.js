// Feature flags travel with a prod release: every active flag on dev's back office is previewed
// against prod when the release opens, and applied once Release all has deployed prod. Prod keeps
// its own stage and on/off. Back-office owns the rules (what travels, what prod keeps, what is
// blocked: flagRelease.js)
// and the access: its flag-release workflow is the only caller the endpoints accept (GitHub's token
// for that workflow on master). Overlord only starts that workflow with `gh` and reads its result,
// so no one holds a key.

const REPO = 'LLSLtd/back-office';
const WORKFLOW = 'flag-release.yml';
const POLL_MS = 5e3;
const WAIT_MS = 10 * 60e3;

function createFlagRelease({ gh, sleep = ms => new Promise(r => setTimeout(r, ms)), now = Date.now, newId = () => Math.random().toString(36).slice(2, 10) }) {
  const ok = async (args) => {
    const r = await gh(args);
    if (r.error) throw new Error(r.error);
    return r.stdout;
  };

  async function dispatch(mode, expect = '') {
    const request = newId();
    await ok(['workflow', 'run', WORKFLOW, '-R', REPO, '--ref', 'master', '-f', `mode=${mode}`, '-f', `expect=${expect}`, '-f', `request=${request}`])
      .catch((e) => { throw /could not find any workflows|not found on the default branch/i.test(e.message) ? new Error('flag-release workflow is not on back-office master yet') : e; });
    // the run is named after the request (run-name), which is how this call finds its own run
    const until = now() + WAIT_MS;
    let run = null;
    while (now() < until) {
      await sleep(POLL_MS);
      const runs = JSON.parse(await ok(['run', 'list', '-R', REPO, '-w', WORKFLOW, '-L', '20', '--json', 'databaseId,displayTitle,status,conclusion']));
      run = runs.find(x => String(x.displayTitle || '').endsWith(` ${request}`));
      if (run && run.status === 'completed') break;
    }
    if (!run || run.status !== 'completed') throw new Error(`flag-release ${mode} did not finish in ${WAIT_MS / 60e3} min`);
    const log = await ok(['run', 'view', String(run.databaseId), '-R', REPO, '--log']);
    const m = log.match(/FLAG_RELEASE_RESULT ([A-Za-z0-9+/=]+)/);
    if (!m) throw new Error(`flag-release run ${run.databaseId} ended ${run.conclusion} without a result`);
    const out = JSON.parse(Buffer.from(m[1], 'base64').toString());
    if (!out.ok) throw new Error(out.error);
    return out.result;
  }

  return {
    preview: () => dispatch('preview'),
    // A failure halfway leaves the first half written: applying the same preview again finishes it.
    apply: p => dispatch('apply', p.fingerprint),
  };
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
  return `Flags: ${bits.length ? bits.join(' · ') : 'nothing to promote'}`;
}

module.exports = { createFlagRelease, summarize, sameSummary, prLine, outcome, any, REPO, WORKFLOW };
