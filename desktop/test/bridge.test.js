'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createBridge, STALE_MS, CODE_MS, CODE_MISSES } = require('../src/core/bridge');
const { defaults } = require('../src/core/store');
const { post } = require('../support/http');

const PART = { type: 'create', class: 'Part', parent: 'Workspace', name: 'Checkpoint', properties: [{ name: 'Anchored', kind: 'boolean', value: 'true' }] };
const REMOVE = { type: 'destroy', path: 'Workspace/Old' };
const draft = (operations, permission) => ({ prompt: 'p', reply: 'r', plan: ['s'], operations, model: 'm', permission: permission || 'review' });

function setup() {
  const state = defaults();
  let clock = Date.parse('2026-01-01T00:00:00Z');
  let changes = 0;
  const bridge = createBridge({ state, now: () => clock, onChange: () => { changes += 1; } });
  return { state, bridge, advance: (ms) => { clock += ms; }, changes: () => changes };
}

function pair(bridge) {
  const { code } = bridge.newPairingCode();
  const out = bridge.handle({ action: 'pair', code, placeName: 'Test place', placeId: '123', pluginVersion: '0.2.0' });
  assert.equal(out.status, 200);
  return out.json.token;
}

test('a run travels from approval to a confirmed result over HTTP', async () => {
  const { state, bridge } = setup();
  const port = await bridge.listen(0);
  try {
    const { code } = bridge.newPairingCode();
    assert.match(code, /^[A-Z2-9]{8}$/);
    const wrong = code === 'AAAAAAAA' ? 'BBBBBBBB' : 'AAAAAAAA';
    assert.equal((await post(port, { action: 'pair', code: wrong })).status, 401);

    const paired = await post(port, { action: 'pair', code: code.toLowerCase(), placeName: 'My Obby', placeId: '42', pluginVersion: '0.2.0' });
    assert.equal(paired.status, 200);
    assert.equal(paired.json.protocol, 1);
    const token = paired.json.token;
    assert.equal(state.place.name, 'My Obby');
    assert.ok(!JSON.stringify(state).includes(token), 'the token itself is never stored');
    assert.equal((await post(port, { action: 'pair', code })).status, 401, 'a code works once');

    assert.equal((await post(port, { action: 'poll', token })).json.job, null);
    const run = bridge.addRun(draft([PART]));
    assert.equal(run.status, 'awaiting_approval');
    assert.equal((await post(port, { action: 'poll', token })).json.job, null, 'nothing is sent before approval');

    bridge.approve(run.id);
    const claimed = await post(port, { action: 'poll', token, tree: { services: [{ n: 'Workspace', c: 'Workspace' }] } });
    assert.deepEqual(claimed.json.job, { id: run.id, operations: [PART] });
    assert.equal(run.status, 'running');
    assert.deepEqual(state.tree, { services: [{ n: 'Workspace', c: 'Workspace' }] });
    assert.equal((await post(port, { action: 'poll', token })).json.job, null, 'a claimed run is not sent twice');

    const report = await post(port, { action: 'report', token, jobId: run.id, undoRecorded: true, results: [{ ok: true, verified: true, message: 'Created Workspace.Checkpoint' }] });
    assert.deepEqual(report.json, { recorded: true });
    assert.equal(run.status, 'completed');
    assert.equal(run.undoRecorded, true);
    assert.deepEqual(run.results, [{ index: 0, ok: true, verified: true, message: 'Created Workspace.Checkpoint' }]);
    assert.equal((await post(port, { action: 'report', token, jobId: run.id, results: [] })).status, 409, 'a finished run cannot be reported again');
    assert.equal((await post(port, { action: 'report', token, jobId: 'missing', results: [] })).status, 404);
  } finally {
    await bridge.close();
  }
});

test('a result is never stored as confirmed unless the operation succeeded', () => {
  const { bridge } = setup();
  const token = pair(bridge);
  const run = bridge.approve(bridge.addRun(draft([PART, PART, PART])).id);
  bridge.handle({ action: 'poll', token });
  bridge.handle({ action: 'report', token, jobId: run.id, results: [{ ok: false, verified: true, message: 'x' }, { ok: 'true', verified: true }, { ok: true, verified: 'yes' }] });
  assert.deepEqual(run.results.map((r) => [r.ok, r.verified]), [[false, false], [false, false], [true, false]]);
  assert.equal(run.status, 'failed');

  const short = bridge.approve(bridge.addRun(draft([PART, PART])).id);
  bridge.handle({ action: 'poll', token });
  bridge.handle({ action: 'report', token, jobId: short.id, results: [{ ok: true, verified: true }] });
  assert.equal(short.status, 'failed');
  assert.equal(short.error, 'Studio reported fewer results than operations.');
});

test('automatic mode queues builds but always holds removals for approval', () => {
  const { bridge } = setup();
  assert.equal(bridge.addRun(draft([PART], 'automatic')).status, 'queued');
  assert.equal(bridge.addRun(draft([PART, REMOVE], 'automatic')).status, 'awaiting_approval');
  assert.equal(bridge.addRun(draft([PART], 'review')).status, 'awaiting_approval');
  assert.equal(bridge.addRun(draft([], 'automatic')).status, 'answered');
});

test('a run Studio went quiet on is failed and never sent again', () => {
  const { bridge, advance } = setup();
  const token = pair(bridge);
  const first = bridge.addRun(draft([PART], 'automatic'));
  const second = bridge.addRun(draft([PART], 'automatic'));
  assert.equal(bridge.handle({ action: 'poll', token }).json.job.id, first.id);
  advance(STALE_MS - 1000);
  assert.equal(bridge.handle({ action: 'poll', token }).json.job, null, 'the next run waits while one is in flight');
  advance(2000);
  assert.equal(bridge.handle({ action: 'poll', token }).json.job.id, second.id);
  assert.equal(first.status, 'failed');
  assert.match(first.error, /not sent again/);
  assert.equal(bridge.handle({ action: 'report', token, jobId: first.id, results: [{ ok: true }] }).status, 409);
});

test('pairing codes expire and lock after repeated misses', () => {
  const { bridge, advance } = setup();
  const first = bridge.newPairingCode();
  advance(CODE_MS + 1);
  assert.equal(bridge.getPairing(), null);
  assert.equal(bridge.handle({ action: 'pair', code: first.code }).status, 401, 'an expired code is refused');

  const second = bridge.newPairingCode();
  const wrong = second.code === 'AAAAAAAA' ? 'BBBBBBBB' : 'AAAAAAAA';
  for (let i = 0; i < CODE_MISSES; i += 1) assert.equal(bridge.handle({ action: 'pair', code: wrong }).status, 401);
  assert.equal(bridge.handle({ action: 'pair', code: second.code }).status, 401, 'the code is locked after too many misses');
  assert.equal(bridge.handle({ action: 'pair', code: 'short' }).status, 400);
  assert.equal(bridge.handle({ action: 'pair' }).status, 400);
});

test('web pages, other hosts, bad tokens and bad bodies are refused', async () => {
  const { state, bridge } = setup();
  const port = await bridge.listen(0);
  try {
    const token = pair(bridge);
    assert.equal((await post(port, { action: 'poll', token }, { Origin: 'https://example.com' })).status, 403);
    assert.equal((await post(port, { action: 'poll', token }, { Host: 'example.com' })).status, 403);
    assert.equal((await post(port, { action: 'poll', token: 'local.' + 'a'.repeat(64) })).status, 401);
    assert.equal((await post(port, { action: 'poll' })).status, 401);
    assert.equal((await post(port, { action: 'report', token: 12345, jobId: 'x' })).status, 401);
    assert.equal((await post(port, 'not json')).status, 400);
    assert.equal((await post(port, '[1,2]')).status, 400);
    assert.equal((await post(port, { action: 'explode', token })).status, 400);
    assert.equal((await post(port, JSON.stringify({ action: 'poll', token, pad: 'x'.repeat(1100000) }))).status, 413);
    bridge.unpair();
    assert.equal(state.tokenHash, '');
    assert.equal((await post(port, { action: 'poll', token })).status, 401, 'disconnecting ends the old pairing');
  } finally {
    await bridge.close();
  }
});

test('runs can only be approved or cancelled while they are still waiting', () => {
  const { bridge } = setup();
  const token = pair(bridge);
  const run = bridge.addRun(draft([PART]));
  bridge.cancel(run.id);
  assert.equal(run.status, 'cancelled');
  assert.throws(() => bridge.approve(run.id), /no longer be approved/);
  assert.equal(bridge.handle({ action: 'poll', token }).json.job, null, 'a cancelled run is never sent');

  const sent = bridge.approve(bridge.addRun(draft([PART])).id);
  bridge.handle({ action: 'poll', token });
  assert.throws(() => bridge.cancel(sent.id), /no longer be cancelled/);
  assert.throws(() => bridge.approve('missing'), /no longer be approved/);
});
