'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createAccount, SIGNED_OUT } = require('../src/core/account');
const { createBridge } = require('../src/core/bridge');
const store = require('../src/core/store');
const { fakeOllama, json } = require('../support/http');

const PART = { type: 'create', class: 'Part', parent: 'Workspace', name: 'Marker', properties: [] };

// A stand-in for the ForgeStudio account endpoint. Each test scripts what it answers and records what it was sent.
async function standIn(answer) {
  const calls = [];
  const server = await fakeOllama({
    'POST /functions/deviceSync': (body, res) => {
      calls.push(body);
      const out = answer(body) || {};
      json(res, out.status || 200, out.json || {});
    },
  });
  return { base: server.base, calls, close: server.close, sent: (action) => calls.filter((c) => c.action === action) };
}

function signedIn(server, extra) {
  const state = store.defaults();
  state.account = { token: 'tok', name: 'Sam', projectId: 'project000001' };
  state.settings.model = 'qwen2.5-coder:3b';
  const bridge = createBridge({ state, onReport: (run) => account.report(run) });
  const account = createAccount({ state, bridge, base: server.base, ollama: { chatJson: async () => ({ reply: 'ok', plan: [], operations: [PART] }) }, ...extra });
  return { state, bridge, account };
}

test('sign-in shows a code, opens only the ForgeStudio approval page, and stores the token once approved', async () => {
  let approved = false;
  let verifyUrl = null;
  const server = await standIn((body) => {
    if (body.action === 'start') return { json: { deviceCode: 'dev.code', userCode: 'ABCD2345', expiresAt: new Date(Date.now() + 60000).toISOString(), interval: 1, verifyUrl: verifyUrl || server.base + '/app/devices?code=ABCD2345' } };
    if (body.action === 'token') return { json: approved ? { status: 'active', token: 'secret-token', account: { name: 'Sam' } } : { status: 'pending' } };
    if (body.action === 'projects') return { json: { projects: [{ id: 'project000001', name: 'Obby', execution_mode: 'local' }] } };
    return null;
  });
  const state = store.defaults();
  const opened = [];
  const vault = { seal: (v) => 'sealed:' + v, open: (v) => v.slice(7) };
  const account = createAccount({ state, base: server.base, vault, openExternal: (url) => opened.push(url), device: { name: 'PC', platform: 'win32', appVersion: '0.2.0' } });

  verifyUrl = 'https://evil.example/app/devices?code=ABCD2345';
  await assert.rejects(account.signIn({ wait: false }), /unexpected sign-in address/);
  assert.deepEqual(opened, [], 'an address on another site is never opened');
  verifyUrl = null;

  const view = await account.signIn({ wait: false });
  assert.equal(view.pending.userCode, 'ABCD2345');
  assert.equal(view.pending.deviceCode, undefined, 'the secret half of sign-in never reaches the window');
  assert.deepEqual(opened, [server.base + '/app/devices?code=ABCD2345']);
  assert.equal(server.sent('start')[0].token, undefined);

  assert.equal(await account.checkApproval(), false);
  assert.equal(account.view().signedIn, false);
  approved = true;
  assert.equal(await account.checkApproval(), true);
  assert.equal(state.account.token, 'sealed:secret-token', 'the token is stored sealed');
  assert.deepEqual(account.view().projects, [{ id: 'project000001', name: 'Obby', planning: 'local' }]);
  assert.equal(server.sent('projects')[0].token, 'secret-token');
  assert.equal(account.runs(), null, 'no shared project is open yet');
  await server.close();
});

test('a request typed on the website is planned by the local model and sent back once', async () => {
  let handed = false;
  let failSubmit = true;
  const server = await standIn((body) => {
    if (body.action === 'sync') {
      const work = body.wantWork && !handed ? { job: { id: 'job0000001', projectId: 'project000001' }, prompt: 'SERVER PROMPT', schema: { type: 'object' } } : null;
      if (work) handed = true;
      return { json: { work, job: null, jobs: [] } };
    }
    if (body.action === 'submit') {
      if (failSubmit) { failSubmit = false; return { status: 500, json: { error: 'temporary outage' } }; }
      return { json: { job: {} } };
    }
    return null;
  });
  let asked = null;
  const { state, account } = signedIn(server, { ollama: { chatJson: async (request) => { asked = request; return { reply: 'Adds a marker', plan: ['Create it'], operations: [PART] }; } } });

  await account.tick();
  assert.deepEqual(asked, { model: 'qwen2.5-coder:3b', prompt: 'SERVER PROMPT', schema: { type: 'object' } }, 'the model gets the instruction ForgeStudio built');
  assert.equal(account.view().error, 'temporary outage');
  assert.equal(state.outbox.length, 1, 'the plan is kept while ForgeStudio cannot be reached');

  await account.tick();
  assert.equal(state.outbox.length, 0);
  const submits = server.sent('submit');
  assert.equal(submits.length, 2);
  assert.equal(submits[1].jobId, 'job0000001');
  assert.equal(submits[1].model, 'qwen2.5-coder:3b');
  assert.deepEqual(submits[1].result.operations, [PART]);

  state.settings.model = '';
  await account.tick();
  assert.equal(server.sent('sync').pop().wantWork, false, 'no work is collected without a model to plan it');
  await server.close();
});

test('a model failure is reported as a failed run rather than left hanging', async () => {
  const server = await standIn((body) => (body.action === 'send' ? { json: { work: { job: { id: 'job0000002' }, prompt: 'P', schema: {} } } } : { json: { jobs: [] } }));
  const { account } = signedIn(server, { ollama: { chatJson: async () => { throw new Error('Ollama: model not found'); } } });
  await account.send('add a door');
  const submit = server.sent('submit')[0];
  assert.equal(submit.error, 'Ollama: model not found');
  assert.equal(submit.result, undefined);
  assert.equal(server.sent('send')[0].prompt, 'add a door');
  await server.close();
});

test('an approved shared run is applied through the local Studio link exactly once and its result goes back', async () => {
  const server = await standIn((body) => {
    if (body.action === 'sync') return { json: { work: null, job: body.studioOnline ? { id: 'job0000003', operations: [PART, { type: 'shell', command: 'x' }] } : null, jobs: [{ id: 'job0000003', prompt: 'p', status: 'running', created_date: '2026-11-14T10:00:00.000000' }] } };
    return { json: { recorded: true } };
  });
  let online = false;
  const { state, bridge, account } = signedIn(server, { studioOnline: () => online });
  const { code } = bridge.newPairingCode();
  const token = bridge.handle({ action: 'pair', code, placeName: 'Obby', placeId: '1', pluginVersion: '0.2.0' }).json.token;

  await account.tick();
  assert.equal(server.sent('sync')[0].studioOnline, false);
  assert.equal(state.runs.length, 0, 'nothing is collected for Studio while Studio is not connected');

  online = true;
  await account.tick();
  assert.equal(state.runs.length, 1);
  assert.deepEqual(state.runs[0].operations, [PART], 'operations are checked again on this computer');
  await account.tick();
  assert.equal(server.sent('sync').pop().studioOnline, false, 'no second run is collected while one is in flight');
  assert.equal(bridge.addRemote({ id: 'job0000003', projectId: 'project000001', operations: [PART] }), null, 'the same run is never accepted twice');
  assert.equal(state.runs.length, 1);

  const polled = bridge.handle({ action: 'poll', token }).json.job;
  assert.equal(polled.id, 'job0000003');
  assert.equal(bridge.handle({ action: 'poll', token }).json.job, null);
  bridge.handle({ action: 'report', token, jobId: 'job0000003', results: [{ ok: true, verified: true, message: 'Created Workspace/Marker' }], undoRecorded: true });
  await new Promise((resolve) => setTimeout(resolve, 50));
  const reports = server.sent('studioReport');
  assert.equal(reports.length, 1);
  assert.equal(reports[0].projectId, 'project000001');
  assert.deepEqual(reports[0].results, [{ index: 0, ok: true, verified: true, message: 'Created Workspace/Marker' }]);
  assert.equal(reports[0].undoRecorded, true);
  assert.equal(state.outbox.length, 0);

  const shown = account.runs();
  assert.equal(shown.length, 1);
  assert.equal(shown[0].createdAt, '2026-11-14T10:00:00.000000Z', 'server times are read as UTC');
  await server.close();
});

test('a result ForgeStudio already has is not sent forever, and a revoked app signs itself out', async () => {
  let revoked = false;
  const server = await standIn((body) => {
    if (revoked) return { status: 401, json: { error: 'invalid_token' } };
    if (body.action === 'studioReport') return { status: 409, json: { error: 'job_not_running' } };
    return { json: { jobs: [] } };
  });
  const { state, account } = signedIn(server);
  state.outbox.push({ action: 'studioReport', payload: { projectId: 'project000001', jobId: 'job0000004', results: [] } });
  await account.tick();
  assert.equal(state.outbox.length, 0);
  assert.equal(account.view().error, '');

  revoked = true;
  await account.tick();
  assert.equal(account.view().signedIn, false);
  assert.equal(state.account.token, '');
  assert.equal(account.view().error, SIGNED_OUT);
  const before = server.calls.length;
  await account.tick();
  assert.equal(server.calls.length, before, 'a signed-out app stops calling ForgeStudio');
  await server.close();
});

test('the account and unsent results survive a restart', () => {
  const fsx = require('fs');
  const file = require('path').join(fsx.mkdtempSync(require('path').join(require('os').tmpdir(), 'forge-test-')), 'forgestudio.json');
  const state = store.defaults();
  state.account = { token: 'enc:abc', name: 'Sam', projectId: 'project000001' };
  state.outbox = [{ action: 'studioReport', payload: { jobId: 'job0000005' } }, { broken: true }];
  store.save(file, state);
  const loaded = store.load(file);
  assert.deepEqual(loaded.account, state.account);
  assert.deepEqual(loaded.outbox, [{ action: 'studioReport', payload: { jobId: 'job0000005' } }]);
});
