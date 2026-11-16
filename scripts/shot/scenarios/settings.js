// Settings: every section with its features off, then on (dependent rows showing). World on so raids show.
//   npx electron scripts/shot/run.js scripts/shot/scenarios/settings.js <outDir>
module.exports = async ({ js, shot, wait, inject }) => {
  await js(`document.body.classList.add('world-on'); toggleSettings(); true`);
  await inject({ type: 'apiState', enabled: true, running: true, port: 7790, file: 'C:/Users/me/.overlord/api.json', tokenTail: 'S0aE' });
  const secs = await js(`[...document.querySelectorAll('#settings-overlay .settings-sec')].map(d => d.dataset.sec)`);
  const pass = async (suffix) => {
    for (const s of secs) {
      await js(`showSettingsSec(${JSON.stringify(s)}); document.querySelector('.settings-panes').scrollTop = 0; true`);
      await wait(150); await shot(s + suffix);
      const more = await js(`(p => p.scrollHeight > p.clientHeight + 4)(document.querySelector(".settings-panes"))`);
      if (more) { await js(`(p => { p.scrollTop = p.scrollHeight; return true; })(document.querySelector(".settings-panes"))`); await wait(150); await shot(s + suffix + '-end'); }
    }
  };
  await pass('');
  await js(`for (const id of ['chk-pr','chk-actions','chk-clickup','chk-peers','chk-world']) document.getElementById(id).checked = true; true`);
  await pass('-on');
};
