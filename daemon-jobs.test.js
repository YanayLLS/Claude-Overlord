const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { unsettledJobFor } = require('./daemon-jobs');

const SID = '9a84cc15-e273-4af4-b857-ef55c2d3191a';
function jobsDir(state, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-jobs-'));
  fs.mkdirSync(path.join(dir, '9a84cc15'));
  fs.writeFileSync(path.join(dir, '9a84cc15', 'state.json'), JSON.stringify({ state, sessionId: SID, daemonShort: '9a84cc15', ...extra }));
  return dir;
}

test('a working or blocked job is reported by its short id', () => {
  assert.strictEqual(unsettledJobFor(jobsDir('working'), SID), '9a84cc15');
  assert.strictEqual(unsettledJobFor(jobsDir('blocked'), SID), '9a84cc15');
});

test('settled jobs are left alone', () => {
  for (const s of ['done', 'stopped', 'failed', 'killed']) assert.strictEqual(unsettledJobFor(jobsDir(s), SID), null);
});

test('no job, another session in the same folder, or a bad id → null', () => {
  assert.strictEqual(unsettledJobFor(fs.mkdtempSync(path.join(os.tmpdir(), 'ov-jobs-')), SID), null);
  assert.strictEqual(unsettledJobFor(jobsDir('working', { sessionId: '9a84cc15-0000-0000-0000-000000000000' }), SID), null);
  assert.strictEqual(unsettledJobFor(jobsDir('working'), '9a84cc15 & calc'), null);
});

test('a job resumed from this session counts too', () => {
  assert.strictEqual(unsettledJobFor(jobsDir('working', { sessionId: 'other', resumeSessionId: SID }), SID), '9a84cc15');
});
