'use strict';
const fs = require('fs');

const INTERRUPTED = 'ForgeStudio was closed before Studio reported a result. The run was not sent again, so check your place before retrying.';

function defaults() {
  return { tokenHash: '', place: null, lastSeen: null, tree: null, treeAt: null, runs: [], settings: { model: '', permission: 'review' }, account: { token: '', name: '', projectId: '' }, outbox: [] };
}

function load(file) {
  const state = defaults();
  if (!fs.existsSync(file)) return state;
  let saved = null;
  try { saved = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) { return state; }
  if (!saved || typeof saved !== 'object') return state;
  if (typeof saved.tokenHash === 'string') state.tokenHash = saved.tokenHash;
  if (saved.place && typeof saved.place === 'object') state.place = saved.place;
  if (Array.isArray(saved.runs)) state.runs = saved.runs.filter((run) => run && typeof run.id === 'string' && Array.isArray(run.operations));
  if (saved.settings && typeof saved.settings === 'object') {
    if (typeof saved.settings.model === 'string') state.settings.model = saved.settings.model;
    if (saved.settings.permission === 'automatic') state.settings.permission = 'automatic';
  }
  if (saved.account && typeof saved.account === 'object') {
    for (const key of ['token', 'name', 'projectId']) if (typeof saved.account[key] === 'string') state.account[key] = saved.account[key];
  }
  if (Array.isArray(saved.outbox)) state.outbox = saved.outbox.filter((item) => item && typeof item.action === 'string' && item.payload && typeof item.payload === 'object');
  // A run that was mid-flight when the app closed has an unknown outcome. It is failed, never re-sent.
  for (const run of state.runs) {
    if (run.status === 'running') {
      run.status = 'failed';
      run.error = INTERRUPTED;
      run.finishedAt = new Date().toISOString();
    }
  }
  return state;
}

function save(file, state) {
  const data = { tokenHash: state.tokenHash, place: state.place, runs: state.runs, settings: state.settings, account: state.account, outbox: state.outbox };
  fs.writeFileSync(file + '.tmp', JSON.stringify(data));
  fs.renameSync(file + '.tmp', file);
}

module.exports = { load, save, defaults, INTERRUPTED };
