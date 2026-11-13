// Release candidate grade. Pure: reads what the nightly BDD regression and its auto-fixer already
// published (the whole-run report page, history.json, the fixer's summary) and answers one question:
// should this night's tested commits go to prod? Nothing here re-runs a test.
//   ship = release · look = release after one named check · hold = don't, and this is why
// The grade is the worst rule that fires. Two ideas keep it from holding every night:
//   - only NEW risk counts: a scenario already red on the night prod last shipped is in prod today;
//   - failures are judged per ROOT CAUSE, by what the fixer concluded about it, not per scenario.
// Self-check: rc-core.test.js

const POLICY = {
  criticalTag: '@critical',
  minorShip: 5,           // new unexplained minor root causes a Ship tolerates…
  minorShipModules: 3,    // …spread over at most this many modules
  minorLook: 15,          // more than this is a Hold
  unreportedShip: 0.15,   // modules missing tonight but green the last time they ran: this share still ships (carried)…
  unreportedLook: 0.3,    // …this share is a Look, more is a Hold. One that was red last time is always a Hold
  coverageDrop: 0.02,     // a module that ran this much fewer scenarios than last night…
  coverageDropMin: 3,     // …and at least this many
  staleLookH: 36,         // evidence older than this is a Look, older than staleHoldH a Hold
  staleHoldH: 72,
  shown: 5,               // root causes named per rule
};

const RANK = { ship: 0, look: 1, hold: 2 };
const worst = (a, b) => (RANK[b] > RANK[a] ? b : a);
const keyOf = (module, name) => `${module}|${name}`;
const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;

// The whole-run report page embeds its data: <script id="run-data" type="application/json">.
function parseRunPage(html) {
  const m = String(html || '').match(/<script id="run-data" type="application\/json">([\s\S]*?)<\/script>/);
  if (!m) return null;
  let j; try { j = JSON.parse(m[1]); } catch { return null; }
  return {
    runUrl: j.runUrl || null,
    modules: (j.profiles || []).map(p => ({ name: p.name, title: p.title || p.name, passed: p.passed || 0, failed: p.failed || 0, flaky: p.flaky || 0, skipped: p.skipped || 0, report: p.report || null })),
    failures: (j.failures || []).map(f => ({ key: keyOf(f.profile, f.name), module: f.profile, name: f.name, tags: f.tags || [], step: f.step || '',
      error: String(f.error || '').split('\n')[0].slice(0, 240), flaky: f.rerun === 'passed on rerun', report: f.report || null, anchor: f.anchor || null, flags: flagsOn(f.steps) })),
    suites: ((j.checks && j.checks.suites) || []).map(s => ({ id: s.id, title: s.title || s.id, repo: s.repo, ref: s.ref || null, sha: s.sha || null, status: s.status, failed: s.failed || 0 })),
  };
}
// Feature flags a scenario switches on in its own steps: `the "IsCommentsEnabled" feature flag is "enabled"`.
const FLAG_ON = /the "([A-Za-z0-9_]+)" feature flag is "(?:enabled|on)"/;
function flagsOn(steps) {
  const out = [];
  for (const s of steps || []) { const m = String(s.name || '').match(FLAG_ON); if (m && !out.includes(m[1])) out.push(m[1]); }
  return out;
}
// a failure's own place in the report (its module page, at its anchor), else the whole-run page
function failureUrl(f, pageUrl) {
  if (!f.report) return pageUrl || null;
  try { return new URL(f.report + (f.anchor ? '#' + f.anchor : ''), pageUrl).href; } catch { return pageUrl || null; }
}

// What the fixer concluded about one root cause. It writes `category` when it knows; older verdicts are read
// from their shape. test = the test was wrong (fixed in test code) · repaired = the app was wrong and the fixer
// patched it · env = the runner broke, not the app · spec = behaviour moved on purpose, product must say which
// is right · product = the app is broken · unexamined = nobody looked (over the nightly cap, or no verdict).
// ponytail: the env/spec split reads the diagnosis's opening words until every verdict carries `category`.
function categoryOf(c) {
  if (c.category) return c.category === 'environment' ? 'env' : c.category; // the fixer's own word (bdd-autofix-review causeCategory)
  if (c.verdict === 'fixed') return c.riskTier === 'T2' ? 'repaired' : 'test';
  if (c.verdict === 'folded') return 'test';
  if (c.verdict !== 'declined' || c.declineReason === 'over-group-cap') return 'unexamined';
  const d = String(c.diagnosis || '').slice(0, 160).toLowerCase();
  if (/environment|does[- ]not[- ]reproduce|not[- ]reproducible/.test(d)) return 'env';
  if ((c.productQuestions || []).length || /spec[- ]change|ambiguous|claim-only/.test(d)) return 'spec';
  return 'unexamined';
}

// history: { nights:[dt…] newest first, scenarios:{key:'FfP-…'}, modules:{name:[[p,f,flaky]|null…]} }.
// The night prod last shipped = the newest night strictly before the prod release day (that night tested
// the dev that was released). -1 when history doesn't reach back that far.
function prodNight(history, prodAt) {
  if (!history || !prodAt) return -1;
  const day = new Date(prodAt).toISOString().slice(0, 10);
  return (history.nights || []).findIndex(dt => dt < day);
}
// was this scenario red the last time it ran on or before night i?
function redAt(history, key, i) {
  const s = history && history.scenarios && history.scenarios[key];
  if (!s || i < 0) return false;
  for (let k = i; k < s.length; k++) if (s[k] !== '-') return s[k] === 'F';
  return false;
}
const DEAD_STACK = /stack runs \S+ to the end/;
const VERIFY_SAID = { invalid: 'was invalid', discarded: 'was discarded', cancelled: 'never finished' };
const RECENT = 3; // a module counts as part of the suite when it reported on one of the last nights
const recent = (rows) => (rows || []).slice(0, RECENT).find(Boolean) || null;

// Failures → root causes. One broken thing is one cause however many scenarios it reddens (148 red scenarios
// behind one dead Mongo are one fact, not 148). The fixer's groups name the cause; a failure it never grouped
// is grouped by module + failing step.
function rootCauses(page, phase, history, pn, evidence, P = POLICY, unreleased = []) {
  const hidden = new Set(unreleased);
  const byScenario = new Map();
  for (const c of (phase && phase.causes) || []) for (const s of c.scenarios || []) byScenario.set(keyOf(s.profile, s.scenario), c);
  const groups = new Map();
  for (const f of page.failures) {
    if (f.flaky) continue;
    const c = byScenario.get(f.key);
    let category = c ? categoryOf(c) : 'unexamined';
    if (evidence === 'verify' && category === 'test') category = 'unexamined'; // fixed, yet still red after the fix
    // a scenario that has to switch on a flag prod hasn't released tests something no customer can reach yet
    if ((f.flags || []).some(k => hidden.has(k))) category = 'unreleased';
    // the runner's own placeholder for a module whose stack died before it reported: the runner broke, not the app
    if (DEAD_STACK.test(f.step)) category = 'env';
    const id = c ? c.key : `${f.module}::${f.step}`;
    const g = groups.get(id) || groups.set(id, { id, category, module: f.module, failures: [],
      question: (c && (c.productQuestions || [])[0]) || null, diagnosis: c ? String(c.diagnosis || '') : '' }).get(id);
    g.failures.push(f);
  }
  for (const g of groups.values()) {
    g.critical = g.failures.some(f => f.tags.includes(P.criticalTag));
    g.fresh = g.failures.some(f => !redAt(history, f.key, pn));   // prod doesn't already have it
    g.confirmed = g.failures.some(f => redAt(history, f.key, 0)); // red on the run before this one too
  }
  return [...groups.values()];
}

// unreleased: flag keys prod has not released (new with this release, or still staged there).
// in: { page, pageUrl, prevPage, history, unreleased, phase (fixer phase-summary), apply (bdd-apply-result), verify: { decision } | null,
//       evidence: 'verify' | 'nightly', prodAt, runAt, now, policy }
// out: { level, rules:[{ id, level, text, items:[{ text, url }] }], headline, counts }
function grade(input) {
  const P = { ...POLICY, ...(input.policy || {}) };
  const { page, history, apply, verify } = input;
  const rules = [];
  // total: how many rows the rule has in all (the card shows the first few)
  const add = (id, level, text, items = [], total = items.length) => rules.push({ id, level, text, items, total });
  if (!page) {
    add('evidence', 'hold', 'No regression report for this night');
    return finish(rules, {});
  }
  const link = (f) => failureUrl(f, input.pageUrl);
  const titleOf = Object.fromEntries(page.modules.map(m => [m.name, m.title]));
  // an item: text (what a person reads) · tag (where) · more (scenarios behind the same cause) · url
  const causeItem = (g) => ({ text: g.failures[0].name, tag: titleOf[g.module] || g.module, more: g.failures.length - 1, url: link(g.failures[0]) });
  const names = (list) => list.slice(0, P.shown).map(causeItem);
  const moduleUrl = (name) => { const m = page.modules.find(x => x.name === name); try { return m && m.report ? new URL(m.report, input.pageUrl).href : input.pageUrl; } catch { return input.pageUrl; } };
  const causes = rootCauses(page, input.phase, history, prodNight(history, input.prodAt), input.evidence, P, input.unreleased || []).filter(g => g.fresh);
  const of = (cat) => causes.filter(g => g.category === cat);

  // 1 ─ is the evidence whole? A module that never reported, or ran on a broken runner, is not a green module.
  const reported = new Set(page.modules.map(m => m.name));
  const known = Object.keys((history && history.modules) || {}).filter(m => !reported.has(m) && recent(history.modules[m]));
  const wasRed = known.filter(m => recent(history.modules[m])[1] > 0);
  const env = of('env'), envScenarios = env.reduce((n, g) => n + g.failures.length, 0);
  if (known.length) {
    const share = known.length / Math.max(1, known.length + reported.size);
    const level = wasRed.length || share > P.unreportedLook ? 'hold' : share > P.unreportedShip ? 'look' : 'ship';
    add('evidence', level, level === 'ship' ? `${plural(known.length, 'module')} carried from the night before, all green`
      : `${plural(known.length, 'module')} never reported${wasRed.length ? `, ${wasRed.length} red last time` : ''}`,
      (wasRed.length ? wasRed : known).slice(0, P.shown).map(m => ({ text: m, tag: 'no report', url: input.pageUrl })), (wasRed.length ? wasRed : known).length);
  } else if (env.length) {
    const dead = [...new Set(env.filter(g => g.failures.every(f => DEAD_STACK.test(f.step))).map(g => g.module))];
    if (dead.length === env.length) add('evidence', 'look', `${plural(dead.length, 'module')} did not finish: the runner stopped first`, dead.slice(0, P.shown).map(m => ({ text: titleOf[m] || m, tag: 'stopped early', url: moduleUrl(m) })), dead.length);
    else add('evidence', 'look', `${plural(envScenarios, 'scenario')} hit a broken runner, not the app`, names(env), env.length);
  }
  else add('evidence', 'ship', 'Every module reported');

  // 2 ─ the app is broken: the fixer said so, or a critical scenario nobody examined is red twice running
  const broken = of('product').filter(g => g.critical).concat(of('unexamined').filter(g => g.critical && g.confirmed));
  const firstRed = of('unexamined').filter(g => g.critical && !g.confirmed);
  if (broken.length) add('critical', 'hold', `${plural(broken.length, 'critical failure')} confirmed`, names(broken), broken.length);
  else if (firstRed.length) add('critical', 'look', `${plural(firstRed.length, 'critical failure')} seen once, not examined`, names(firstRed), firstRed.length);
  else add('critical', 'ship', 'No new critical failure');

  // 3 ─ everything else that is new and unexplained
  const minor = of('product').concat(of('unexamined')).filter(g => !g.critical);
  const minorModules = new Set(minor.map(g => g.module)).size;
  if (minor.length > P.minorLook) add('minor', 'hold', plural(minor.length, 'new minor failure'), names(minor), minor.length);
  else if (minor.length > P.minorShip || minorModules > P.minorShipModules) add('minor', 'look', `${plural(minor.length, 'new minor failure')} in ${plural(minorModules, 'module')}`, names(minor), minor.length);
  else add('minor', 'ship', minor.length ? plural(minor.length, 'new minor failure') : 'No new minor failure', names(minor), minor.length);

  // 4 ─ behaviour moved on purpose and the scenario still claims the old one: product has to say which is right
  const spec = of('spec');
  if (spec.length) add('spec', 'look', `${plural(spec.length, 'product question')} open`,
    spec.slice(0, P.shown).map(g => ({ text: String(g.question || g.diagnosis).slice(0, 160), tag: titleOf[g.module] || g.module, url: link(g.failures[0]) })), spec.length);

  const hid = of('unreleased');
  if (hid.length) add('unreleased', 'ship', `${plural(hid.length, 'failure')} only in features prod has not released`,
    hid.slice(0, P.shown).map(g => ({ text: g.failures[0].name, tag: g.failures[0].flags.filter(k => (input.unreleased || []).includes(k)).join(', '), url: link(g.failures[0]) })));

  // 5 ─ a suite that got smaller looks green while it guards less
  const shrunk = [], stopped = new Set(env.flatMap(g => g.failures.filter(f => DEAD_STACK.test(f.step)).map(f => f.module)));
  for (const m of page.modules) {
    if (stopped.has(m.name)) continue; // already named under the evidence rule
    const before = recent(history && history.modules && history.modules[m.name]);
    if (!before) continue;
    const was = before[0] + before[1] + before[2], now = m.passed + m.failed + m.flaky;
    if (was - now >= P.coverageDropMin && (was - now) / was > P.coverageDrop) shrunk.push({ text: m.title, tag: `${was} → ${now}`, url: moduleUrl(m.name) });
  }
  if (shrunk.length) add('coverage', 'look', `${plural(shrunk.length, 'module')} ran fewer scenarios than last night`, shrunk.slice(0, P.shown), shrunk.length);
  else add('coverage', 'ship', 'Coverage held');

  // 6 ─ what the fixer did to the app, and whether its verify run stands
  const appFix = (apply && (apply.commits || []).filter(c => c.riskTier === 'T2')) || [];
  if (verify && verify.decision && verify.decision !== 'pr') add('fixer', 'look', `The fixer's verify run ${VERIFY_SAID[verify.decision] || verify.decision}: graded on the nightly itself`);
  else if (appFix.length || of('repaired').length) add('fixer', 'look', 'The fixer changed app code: this release needs that patch merged',
    appFix.slice(0, P.shown).map(c => ({ text: String(c.cause || '').slice(0, 160), tag: titleOf[c.module] || c.module, url: null })));
  else if (apply && (apply.commits || []).length) add('fixer', 'ship', 'Fixer: test-only fixes');
  else add('fixer', 'ship', input.phase || apply ? 'Fixer changed nothing' : 'No fixer run');

  // 7 ─ the other suites the nightly runs (unit, integration, build): only one that turned red since the night before
  const red = (p) => new Set(((p && p.suites) || []).filter(s => s.status === 'fail' || s.status === 'error').map(s => s.id));
  const before = input.prevPage ? red(input.prevPage) : new Set(), tonight = red(page);
  const newRed = page.suites.filter(s => tonight.has(s.id) && !before.has(s.id));
  if (newRed.length) add('checks', 'look', `${plural(newRed.length, 'suite')} turned red`, newRed.slice(0, P.shown).map(s => ({ text: s.title, tag: s.failed ? `${s.failed} failed` : '', url: input.pageUrl })));
  else if (page.suites.length) add('checks', 'ship', tonight.size ? 'No suite turned red' : 'Unit and build suites green');

  // 8 ─ how old the evidence is
  const ageH = input.runAt ? ((input.now || Date.now()) - Date.parse(input.runAt)) / 3600e3 : 0;
  if (ageH > P.staleHoldH) add('age', 'hold', `Evidence is ${Math.round(ageH / 24)} days old`);
  else if (ageH > P.staleLookH) add('age', 'look', `Evidence is ${Math.round(ageH)} hours old`);

  return finish(rules, { causes: causes.length, broken: broken.length, firstRed: firstRed.length, minor: minor.length, spec: spec.length,
    env: envScenarios, test: of('test').length, flaky: page.failures.filter(f => f.flaky).length, unreported: known.length });
}

// an item as one line of words, for the headline and the AI
const said = (i) => i.text + (i.tag ? ` (${i.tag})` : '');
function finish(rules, counts) {
  const level = rules.reduce((l, r) => worst(l, r.level), 'ship');
  const first = rules.find(r => r.level === level && level !== 'ship');
  const lead = first && first.items[0] ? `${first.text}: ${said(first.items[0])}` : first && first.text;
  const headline = level === 'ship' ? 'Release.' : level === 'look' ? `Release after one check. ${lead}.` : `Don't release. ${lead}.`;
  return { level, rules, headline, counts };
}

// Demo mode (OVERLORD_RC_DEMO): the same night, shown as it would look on a clean one, so the whole
// path can be walked without a real release. It says so on the card.
function demoCandidate(c) {
  if (!c || !c.shas) return c;
  const rules = ['Every module reported', 'No new critical failure', 'No new minor failure', 'Coverage held', 'Fixer: test-only fixes', 'No suite turned red']
    .map((text, i) => ({ id: 'demo' + i, level: 'ship', text, items: [] }));
  return { ...c, demo: true, level: 'ship', headline: 'Release.', rules, counts: {}, context: null,
    ai: { text: 'Release. Every module reported and nothing new is failing since the last prod release.' } };
}
// Is this `gh` call a read? Demo mode lets only these through. `gh api` is a GET unless it names
// another method or carries fields without saying GET.
function ghIsRead(args) {
  if (!Array.isArray(args) || args[0] !== 'api') return false;
  const x = args.indexOf('-X'), method = x >= 0 ? String(args[x + 1] || '').toUpperCase() : args.indexOf('--method') >= 0 ? String(args[args.indexOf('--method') + 1] || '').toUpperCase() : null;
  if (method) return method === 'GET';
  return !args.some(a => ['-f', '-F', '--field', '--raw-field', '--input'].includes(a));
}

// The AI only explains; the grade is already decided. It may not lift a hold.
function aiPrompt(result, extra = {}) {
  const lines = result.rules.map(r => `- [${r.level}] ${r.text}${r.items.length ? ': ' + r.items.map(said).join('; ') : ''}`);
  return [
    'You advise a product team on whether to release tonight\'s release candidate to production.',
    `The rule engine already graded it: ${result.level.toUpperCase()} (ship = release, look = release after a check, hold = do not release).`,
    'Rules that fired:', ...lines,
    extra.failures ? 'Failing scenarios with their first error line:\n' + extra.failures : '',
    extra.fixer ? 'What the nightly auto-fixer concluded:\n' + extra.fixer : '',
    'Answer in ONE plain sentence of at most 18 words for a product manager: what this means for users if it shipped. The card already shows the grade and lists the failing scenarios under it, so do not repeat the grade, do not say whether to release, and do not list scenarios or counts. Name features the way a user would, never a code id.',
    'Do not contradict the grade. No preamble, no markdown, no em dash.',
  ].filter(Boolean).join('\n');
}

// From the workflow's runs ({ id, event, conclusion, createdAt }), tonight's chain: the newest scheduled
// run, the scheduled run before it, and the dispatches after it (one of them is its verify run).
function nightChain(runs) {
  const list = [...(runs || [])].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const i = list.findIndex(r => r.event === 'schedule');
  if (i < 0) return null;
  return { nightly: list[i], previous: list.slice(i + 1).find(r => r.event === 'schedule') || null,
    after: list.slice(0, i).filter(r => r.event === 'workflow_dispatch').reverse() };
}

// A manual run that counts as a night: it ran the unit/build suites too (only a full run asks for them; a
// verify run never does), and the gating repo's own suites tested its release source branch.
// ponytail: only the gating repo's ref is checked; the nightly tests some repos on a branch the release
// doesn't promote from (remote-support-web: dev vs staging), so the others can't be held to their source.
const isFullRun = (page, repo, ref) => !!page && page.suites.some(s => s.repo === repo) && page.suites.every(s => s.repo !== repo || !s.ref || s.ref === ref);

// The commit each repo was tested at: the frontend from the fixer's base (or its build suite), the rest
// from the nightly's own suites. { 'frontlineio-frontend': sha, … } keyed by repo name (no owner).
function testedShas(page, apply, frontend = 'frontlineio-frontend') {
  const out = {};
  for (const s of (page && page.suites) || []) if (s.repo && s.sha && !out[s.repo]) out[s.repo] = s.sha;
  if (apply && apply.baseSha) out[frontend] = apply.baseSha;
  return out;
}

module.exports = { POLICY, parseRunPage, flagsOn, demoCandidate, ghIsRead, failureUrl, categoryOf, rootCauses, prodNight, redAt, grade, aiPrompt, nightChain, isFullRun, testedShas };
