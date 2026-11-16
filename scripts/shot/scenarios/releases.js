// The Releases board (Environments) and the Release tab's picker, with a realistic spread of states.
//   npx electron scripts/shot/run.js scripts/shot/scenarios/releases.js <outDir> 1440 900
module.exports = async ({ inject, js, shot, wait }) => {
  const now = Date.now(), M = 60000, H = 60 * M, D = 24 * H;
  const iso = (ago) => new Date(now - ago).toISOString();
  const envs = ['dev', 'alpha', 'staging', 'prod'];
  let n = 0;
  const commit = (pr, ago) => ({ sha: (0xabc1230 + ++n).toString(16) + '0000000000', title: `#${pr} fix: something`, date: iso(ago), author: 'dev', url: 'https://github.com/x' });
  const run = (state, ago) => ({ state, date: iso(ago), url: 'https://github.com/x', runNumber: 1 });
  const next = (to, ahead, behind = 0) => ({ to, ahead, behind, url: 'https://github.com/x', backUrl: 'https://github.com/x' });
  const cell = (env, pr, ago, extra = {}) => ({ env, branch: env, deploy: 'deploy.yml', commit: commit(pr, ago), run: run('success', ago), nexts: [], ...extra });
  const uses = (env) => ({ env, uses: 'dev' });
  const app = [
    ['frontend', [cell('dev', 1756, 15 * M, { run: run('running', 2 * M), nexts: [next('alpha', 6406), next('prod', 366, 1)] }), cell('alpha', 1543, 11 * D), cell('staging', 1245, 28 * D), cell('prod', 1748, 2 * H)]],
    ['backend', [cell('dev', 2469, 12 * M, { nexts: [next('alpha', 274), next('prod', 18)] }), cell('alpha', 2410, 11 * D), cell('staging', 2030, 77 * D), cell('prod', 2464, 7 * H)]],
  ];
  const svc = [
    ['auth-server', 52, 4, 50], ['identity-server', 153, 15, 151], ['back-office', 427, 11, 423], ['frontline-io-AI', 66, 2, 65],
    ['AI-chat-front', 190, 5, 188, 165], ['remote-support-web', 561, 14, 555, 419], ['Websocket', 17, 2, 16], ['mediaserver', 11, 0, 10],
  ].map(([l, d, w, p, st]) => [l, [cell('dev', d, 32 * M, { nexts: [next('prod', w, l === 'back-office' ? 3 : 0)] }), uses('alpha'), st ? cell('staging', st, 35 * D) : uses('staging'), cell('prod', p, D)]]);
  svc.push(['frontline-jobs', [cell('dev', 26, 32 * M, { run: { ...run('failure', 32 * M), failed: [{ job: 'deploy', step: 'push image' }] }, nexts: [next('prod', 2)] }), null, null, cell('prod', 25, 14 * D, { run: { ...run('partial', 5 * D), failed: [{ job: 'release', step: 'Submit to the Microsoft Store' }] } })]]);
  svc.push(['atlas-search', [cell('dev', 0, 39 * 7 * D, { deploy: 'manual', commit: { ...commit(0, 39 * 7 * D), title: 'chore: x' }, run: null }), uses('alpha'), uses('staging'),
    cell('prod', 0, 39 * 7 * D, { deploy: 'manual', commit: { ...commit(0, 39 * 7 * D), title: 'chore: x' }, run: null })]]);
  svc.push(['partlens-embed-lambda', [cell('dev', 20, 33 * M, { nexts: [next('prod', 2)] }), uses('alpha'), uses('staging'),
    cell('prod', 19, D, { deploy: 'manual', run: null, live: { sha: 'bbbbbbb000', title: 'x', date: iso(D), url: 'u', compareUrl: 'u', behind: 0, from: 'x:y' } })]]);
  const rows = [...app.map(([l, c]) => ({ repo: 'LLSLtd/' + l, label: l, group: 'App', cells: c })), ...svc.map(([l, c]) => ({ repo: 'LLSLtd/' + l, label: l, group: 'Services', cells: c }))];
  const repos = rows.map(r => ({ repo: r.repo, label: r.label, branches: { dev: 'dev', alpha: 'alpha', staging: 'staging', prod: 'main' },
    promote: r.group === 'App' ? [['dev', 'alpha'], ['dev', 'prod']] : ['dev', 'prod'], deploy: { dev: 'deploy.yml', prod: 'deploy.yml' } }));
  const state = { source: 'LLSLtd/release-config', updatedAt: iso(0), config: { envs, repos, releaseOrder: [['frontline-jobs'], rows.map(r => r.label).filter(l => l !== 'frontline-jobs')] }, rc: { level: 'ship', released: true, night: iso(18 * H) }, grid: { envs, rows }, history: { repo: 'LLSLtd/release-manifests', items: [] }, approvers: { members: [1, 2, 3], isApprover: true } };
  await inject({ type: 'releases', state, open: true });
  await wait(800);
  await js(`document.querySelector('[data-act="tab"][data-tab="envs"]').click(); true`);
  await wait(400);
  await shot('board');
  await js(`(() => { const el = document.querySelector('.rl-cell.st-part'); el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); return true; })()`);
  await shot('tip');
  await js(`document.querySelector('[data-act="tab"][data-tab="release"]').click(); true`);
  await wait(400);
  await shot('release');
  await js(`document.querySelector('[data-act="relToggle"][data-env="alpha"]').click(); true`);
  await wait(200);
  await js(`document.querySelector('[data-act="relRepo"][data-repo="LLSLtd/frontline-jobs"]').click(); true`);
  await wait(300);
  await shot('release-leftout');
};
