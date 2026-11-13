// The nightly release candidate, main-process side: finds last night's regression (and the fixer's verify
// run when it stands), reads what they already published, and grades it with rc-core. Read-only: it
// downloads two small artifacts and three public pages, and never re-runs a test.
// Deleting the feature = this file, rc-core.js and the `rc` lines in releases-main.js / releases-ui.js.

const fs = require('fs');
const path = require('path');
const https = require('https');
const zlib = require('zlib');
const { execFile, spawn } = require('child_process');
const { parseRunPage, grade, aiPrompt, nightChain, isFullRun, testedShas } = require('./rc-core');
const { releasePlan } = require('./releases-core');

// The repo whose nightly gates a release, and where its report pages are served. `rc` in the release
// config overrides any of these; `rc: false` turns the candidate off.
const DEFAULTS = { repo: 'LLSLtd/frontlineio-frontend', workflow: 'bdd-regression.yml', reports: 'https://d2i3r8oh2hmvtu.cloudfront.net/regression', model: 'haiku' };
const AI_TIMEOUT_MS = 120e3;
const SIGN_OFF = /^I (AM DONE|NEED YOU\b.*|AM WORKING\b.*)$/;
const SIGN_OFF_TAIL = /\s*I (AM DONE|NEED YOU:.*|AM WORKING.*)$/;
const MANUAL_SCAN = 3; // dispatches after the nightly looked at for a full manual run
const VERIFY_SCAN = 5; // dispatches after the nightly looked at for its verify run

const httpText = (url) => new Promise((resolve) => {
  https.get(url, { headers: { 'accept-encoding': 'gzip' }, timeout: 30e3 }, (r) => {
    const parts = [];
    r.on('data', d => parts.push(d));
    r.on('end', () => {
      let body = Buffer.concat(parts);
      try { if (r.headers['content-encoding'] === 'gzip') body = zlib.gunzipSync(body); } catch { return resolve({ error: 'bad gzip' }); }
      resolve(r.statusCode === 200 ? { text: body.toString('utf8') } : { error: `HTTP ${r.statusCode}` });
    });
  }).on('error', e => resolve({ error: e.message })).on('timeout', function () { this.destroy(new Error('timed out')); });
});
const ghDownload = (repo, run, name, dir) => new Promise((resolve) => execFile('gh', ['run', 'download', String(run), '-R', repo, '-n', name, '-D', dir],
  { timeout: 120e3, windowsHide: true, shell: process.platform === 'win32' }, (err) => resolve(!err)));
// one question to Claude, the prompt on stdin (no shell quoting), the answer on stdout
const claudeAsk = (prompt, model) => new Promise((resolve) => {
  const p = spawn('claude', ['-p', '--model', model], { windowsHide: true, shell: process.platform === 'win32' });
  let out = '', err = '';
  const timer = setTimeout(() => { p.kill(); resolve({ error: 'timed out' }); }, AI_TIMEOUT_MS);
  p.stdout.on('data', d => { out += d; }); p.stderr.on('data', d => { err += d; });
  p.on('error', e => { clearTimeout(timer); resolve({ error: e.message }); });
  p.on('close', (code) => { clearTimeout(timer); resolve(code === 0 && out.trim() ? { text: out.trim() } : { error: err.trim().split('\n')[0] || `claude exited ${code}` }); });
  p.stdin.end(prompt);
});
const findFile = (dir, name) => {
  if (!fs.existsSync(dir)) return null;
  for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, f.name);
    const hit = f.isDirectory() ? findFile(p, name) : f.name === name ? p : null;
    if (hit) return hit;
  }
  return null;
};

module.exports = function createRc({ ghJson, stateDir, fetchText = httpText, download = ghDownload, ask = claudeAsk, now = Date.now }) {
  const api = (...a) => ghJson(['api', ...a]);
  const settings = (cfg) => ({ ...DEFAULTS, ...((cfg && cfg.rc) || {}) });
  const full = new Map(); // run id → is it a full manual run (a finished run never changes)

  // a run's artifact, kept on disk: a night's artifacts never change
  async function artifact(repo, run, name, file) {
    const dir = path.join(stateDir, 'rc', String(run), name);
    if (!fs.existsSync(dir) && !(await download(repo, run, name, dir))) return null;
    const f = findFile(dir, file);
    try { return f ? JSON.parse(fs.readFileSync(f, 'utf8')) : null; } catch { return null; }
  }

  // the dispatch after the nightly whose `verify` job really ran: the fixer's second full regression
  async function verifyRun(repo, after) {
    let cancelled = false;
    for (const r of after.filter(x => x.status === 'completed').slice(0, VERIFY_SCAN)) {
      const jobs = await api('-X', 'GET', `repos/${repo}/actions/runs/${r.id}/jobs`, '-f', 'per_page=100');
      const v = ((jobs.data && jobs.data.jobs) || []).find(j => j.name === 'verify');
      if (!v || !v.conclusion || v.conclusion === 'skipped') continue; // an ordinary dispatch, not a verify run
      // a cancelled run's verify job may still "succeed" on the buckets that never finished: that decided nothing
      if (r.conclusion === 'cancelled' || v.conclusion === 'cancelled') { cancelled = true; continue; }
      return { run: r };
    }
    return cancelled ? { cancelled: true } : null;
  }

  // What the verify run decided, read off the fix PR it opened (or didn't): pr | invalid | discard.
  async function fixPr(repo, nightlyId) {
    const r = await api('-X', 'GET', `repos/${repo}/pulls`, '-f', 'state=all', '-f', `head=${repo.split('/')[0]}:bdd/auto-fix-${nightlyId}`, '-f', 'per_page=5');
    const pr = (r.data || [])[0];
    return pr ? { number: pr.number, url: pr.html_url, merged: !!pr.merged_at, open: pr.state === 'open', invalid: /INVALID/i.test(pr.title || '') } : null;
  }

  // cfg: the release config. unreleased: flag keys prod hasn't released. → the candidate, or { off } / { error }.
  async function compute({ cfg, unreleased = [] }) {
    if (cfg && cfg.rc === false) return { off: true };
    const S = settings(cfg);
    const listed = await api('-X', 'GET', `repos/${S.repo}/actions/workflows/${S.workflow}/runs`, '-f', 'per_page=40');
    if (listed.error || !listed.data) return { error: listed.error || 'could not list the nightly runs' };
    const chain = nightChain((listed.data.workflow_runs || []).map(r => ({ id: r.id, event: r.event, status: r.status, conclusion: r.conclusion, createdAt: r.created_at, attempt: r.run_attempt || 1, title: r.display_title || '' })));
    if (!chain) return { error: 'no scheduled nightly run found' };
    const pageUrlOf = (r) => `${S.reports}/${r.id}-${r.attempt}/results/cucumber-report.run.html`;
    const prodRow = releasePlan(cfg, ['prod']).prs;
    const mine = prodRow.find(p => p.repo.toLowerCase() === S.repo.toLowerCase());
    // A full regression someone ran by hand after the last scheduled night is the newer evidence: grade that.
    let { nightly, previous, after } = chain, manual = false;
    for (const r of [...after].reverse().filter(x => x.status === 'completed' && x.conclusion !== 'cancelled' && !/rs-web/.test(x.title)).slice(0, MANUAL_SCAN)) {
      if (!full.has(r.id)) { const p = await fetchText(pageUrlOf(r)); if (p.text) full.set(r.id, isFullRun(parseRunPage(p.text), S.repo.split('/')[1], (mine && mine.source) || 'dev')); }
      if (!full.get(r.id)) continue;
      previous = nightly; nightly = r; manual = true;
      after = after.filter(x => Date.parse(x.createdAt) > Date.parse(r.createdAt));
      break;
    }
    if (nightly.status !== 'completed') return { night: nightly.createdAt, nightlyId: nightly.id, running: true };

    const [verify, pr, apply, phase] = await Promise.all([verifyRun(S.repo, after), fixPr(S.repo, nightly.id),
      artifact(S.repo, nightly.id, 'bdd-autofix-apply-result', 'bdd-apply-result.json'),
      artifact(S.repo, nightly.id, 'bdd-autofix-results', 'phase-summary.json')]);
    // the verify run is the evidence only when it stands: it ran, and its PR isn't marked invalid
    const decision = !verify ? null : verify.cancelled ? 'cancelled' : !pr ? 'discarded' : pr.invalid ? 'invalid' : 'pr';
    const evidence = decision === 'pr' ? verify.run : nightly;
    const pageUrl = pageUrlOf(evidence);
    const [pageRes, histRes, prevRes, prodTip] = await Promise.all([fetchText(pageUrl), fetchText(pageUrl.replace('cucumber-report.run.html', 'history.json')),
      previous ? fetchText(pageUrlOf(previous)) : null, mine ? api(`repos/${S.repo}/commits/${mine.target}`) : null]);
    const page = pageRes.text ? parseRunPage(pageRes.text) : null;
    let history = null; try { history = histRes.text ? JSON.parse(histRes.text) : null; } catch {}
    const prodAt = prodTip && prodTip.data && prodTip.data.commit ? prodTip.data.commit.committer.date : null;
    const result = grade({ page, pageUrl, prevPage: prevRes && prevRes.text ? parseRunPage(prevRes.text) : null, history, phase, apply, unreleased,
      verify: decision ? { decision } : null, evidence: decision === 'pr' ? 'verify' : 'nightly', prodAt, runAt: evidence.createdAt, now: now(), policy: S.policy });

    // The commits this candidate is: what the nightly tested, per repo. A repo the nightly has no suite for
    // is pinned where its source branch stood when the nightly started.
    const tested = testedShas(page, apply, S.repo.split('/')[1]);
    const shas = {};
    await Promise.all(prodRow.map(async (p) => {
      const known = tested[p.repo.split('/')[1]];
      if (known) { shas[p.repo] = { sha: known, tested: true }; return; }
      const at = await api('-X', 'GET', `repos/${p.repo}/commits`, '-f', `sha=${p.source}`, '-f', `until=${nightly.createdAt}`, '-f', 'per_page=1');
      const c = (at.data || [])[0];
      if (c && c.sha) shas[p.repo] = { sha: c.sha, tested: false };
    }));
    return { night: nightly.createdAt, nightlyId: nightly.id, manual, evidence: { kind: decision === 'pr' ? 'verify' : 'nightly', runId: evidence.id, reportUrl: pageUrl,
      runUrl: `https://github.com/${S.repo}/actions/runs/${evidence.id}` }, fixPr: pr, ...result, shas, unreleased, computedAt: now(),
      // what the AI is given beyond the rules: each failure's first error line, and the fixer's own words
      context: page ? {
        failures: page.failures.filter(f => !f.flaky).slice(0, 25).map(f => `- ${f.module}: ${f.name} | ${f.error}`).join('\n'),
        fixer: ((phase && phase.causes) || []).filter(c => c.diagnosis && c.declineReason !== 'over-group-cap').slice(0, 12)
          .map(c => `- ${c.profile} (${(c.scenarios || []).length} scenarios): ${String(c.diagnosis).slice(0, 300)}`).join('\n'),
      } : null };
  }

  // the two-line explanation; the grade is already decided and the prompt says so
  async function explain(rc, cfg) {
    const r = await ask(aiPrompt(rc, rc.context || {}), settings(cfg).model);
    // ponytail: `claude -p` reads the user's own CLAUDE.md, so a house sign-off line can trail the answer; drop it
    const lines = (r.text || '').split('\n').map(l => l.trim()).filter(l => l && !SIGN_OFF.test(l));
    return lines.length ? { text: lines.slice(0, 3).join(' ').replace(SIGN_OFF_TAIL, '').trim() } : { error: r.error || 'no answer' };
  }

  return { compute, explain };
};
