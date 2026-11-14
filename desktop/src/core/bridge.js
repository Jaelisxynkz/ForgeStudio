'use strict';
// Local link between this app and the ForgeStudio plugin in Roblox Studio.
// It listens on this computer only and speaks the same protocol as the cloud workspace.

const http = require('http');
const crypto = require('crypto');
const { PROTOCOL, cleanTree } = require('./protocol');

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_MS = 10 * 60 * 1000;
const CODE_MISSES = 10;
const STALE_MS = 5 * 60 * 1000;
const MAX_BODY = 1024 * 1024;
const MAX_RUNS = 200;
const PROJECT_NAME = 'ForgeStudio Desktop';
const STALE_ERROR = 'Studio claimed this run but reported no result within 5 minutes. It was not sent again, so check your place before retrying.';

const sha = (value) => crypto.createHash('sha256').update(value).digest('hex');
const text = (value, max) => (typeof value === 'string' ? value.slice(0, max) : '');
const same = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

function createBridge({ state, onChange = () => {}, now = () => Date.now() }) {
  let pairing = null;
  let server = null;
  const iso = () => new Date(now()).toISOString();
  const changed = () => onChange(state);
  const find = (id) => state.runs.find((run) => run.id === id);

  function getPairing() {
    if (pairing && now() > pairing.expires) pairing = null;
    return pairing ? { code: pairing.code, expires: pairing.expires } : null;
  }

  function newPairingCode() {
    const code = Array.from(crypto.randomBytes(8), (byte) => ALPHABET[byte % ALPHABET.length]).join('');
    pairing = { code, expires: now() + CODE_MS, misses: 0 };
    changed();
    return getPairing();
  }

  function unpair() {
    state.tokenHash = '';
    state.place = null;
    pairing = null;
    changed();
  }

  // A run with removals always waits for approval, whatever the permission setting says.
  function addRun({ prompt, reply, plan, operations, model, permission }) {
    let status = 'answered';
    if (operations.length > 0) {
      const hasRemoval = operations.some((op) => op.type === 'destroy');
      status = permission === 'automatic' && !hasRemoval ? 'queued' : 'awaiting_approval';
    }
    const run = {
      id: crypto.randomBytes(10).toString('hex'),
      prompt, reply, plan, operations, model: model || '', status,
      results: [], error: '', undoRecorded: false, createdAt: iso(), claimedAt: null, finishedAt: null,
    };
    state.runs.push(run);
    if (state.runs.length > MAX_RUNS) state.runs.splice(0, state.runs.length - MAX_RUNS);
    changed();
    return run;
  }

  function approve(id) {
    const run = find(id);
    if (!run || run.status !== 'awaiting_approval') throw new Error('This run can no longer be approved');
    run.status = 'queued';
    changed();
    return run;
  }

  function cancel(id) {
    const run = find(id);
    if (!run || !['awaiting_approval', 'queued'].includes(run.status)) throw new Error('This run can no longer be cancelled');
    run.status = 'cancelled';
    run.finishedAt = iso();
    changed();
    return run;
  }

  function authorised(token) {
    return typeof token === 'string' && token.length <= 200 && Boolean(state.tokenHash) && same(sha('forge-plugin:' + token), state.tokenHash);
  }

  function saveTree(tree) {
    const clean = cleanTree(tree);
    if (!clean) return;
    state.tree = clean;
    state.treeAt = iso();
  }

  function handle(body) {
    const action = body.action;

    if (action === 'pair') {
      const code = text(body.code, 20).trim().toUpperCase();
      if (!/^[A-Z2-9]{8}$/.test(code)) return { status: 400, json: { error: 'invalid_code' } };
      const current = getPairing();
      if (!current) return { status: 401, json: { error: 'invalid_code' } };
      if (!same(code, current.code)) {
        pairing.misses += 1;
        if (pairing.misses >= CODE_MISSES) pairing = null;
        changed();
        return { status: 401, json: { error: 'invalid_code' } };
      }
      const token = 'local.' + crypto.randomBytes(32).toString('hex');
      state.tokenHash = sha('forge-plugin:' + token);
      state.place = { name: text(body.placeName, 120), id: text(String(body.placeId || ''), 30), pluginVersion: text(body.pluginVersion, 20), pairedAt: iso() };
      state.lastSeen = iso();
      pairing = null;
      changed();
      return { status: 200, json: { token, projectName: PROJECT_NAME, protocol: PROTOCOL } };
    }

    if (!authorised(body.token)) return { status: 401, json: { error: 'invalid_token' } };
    state.lastSeen = iso();

    if (action === 'poll') {
      saveTree(body.tree);
      let busy = false;
      for (const run of state.runs.filter((r) => r.status === 'running')) {
        // A run Studio claimed and then went quiet on is failed rather than re-sent, so it can never apply twice.
        if (now() - new Date(run.claimedAt).getTime() > STALE_MS) {
          run.status = 'failed';
          run.finishedAt = iso();
          run.error = STALE_ERROR;
        } else {
          busy = true;
        }
      }
      const next = busy ? null : state.runs.find((r) => r.status === 'queued');
      if (next) {
        next.status = 'running';
        next.claimedAt = iso();
      }
      changed();
      return { status: 200, json: { protocol: PROTOCOL, projectName: PROJECT_NAME, job: next ? { id: next.id, operations: next.operations } : null } };
    }

    if (action === 'report') {
      const run = typeof body.jobId === 'string' ? find(body.jobId) : null;
      if (!run) return { status: 404, json: { error: 'job_not_found' } };
      if (run.status !== 'running') return { status: 409, json: { error: 'job_not_running' } };
      const expected = run.operations.length;
      const results = (Array.isArray(body.results) ? body.results : []).slice(0, expected).map((r, index) => ({
        index,
        ok: Boolean(r && r.ok === true),
        verified: Boolean(r && r.ok === true && r.verified === true),
        message: text(r && r.message, 500),
      }));
      const allOk = results.length === expected && results.every((r) => r.ok);
      run.status = allOk ? 'completed' : 'failed';
      run.results = results;
      run.undoRecorded = body.undoRecorded === true;
      run.finishedAt = iso();
      run.error = allOk ? '' : (results.length < expected ? 'Studio reported fewer results than operations.' : 'One or more operations failed in Studio.');
      saveTree(body.tree);
      changed();
      return { status: 200, json: { recorded: true } };
    }

    return { status: 400, json: { error: 'unknown_action' } };
  }

  function listen(port, host = '127.0.0.1') {
    server = http.createServer((req, res) => {
      const send = (status, json) => {
        const payload = JSON.stringify(json);
        res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) });
        res.end(payload);
      };
      if (req.method !== 'POST' || req.url !== '/pluginBridge') return send(404, { error: 'not_found' });
      // Studio never sends an Origin header and always calls 127.0.0.1, so anything else is a web page probing this port.
      if (req.headers.origin || !/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(req.headers.host || '')) return send(403, { error: 'forbidden' });
      const chunks = [];
      let size = 0;
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size <= MAX_BODY) chunks.push(chunk);
      });
      req.on('end', () => {
        if (size > MAX_BODY) return send(413, { error: 'too_large' });
        let body = null;
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (error) { body = null; }
        if (!body || typeof body !== 'object' || Array.isArray(body)) return send(400, { error: 'invalid_json' });
        const out = handle(body);
        send(out.status, out.json);
      });
    });
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => resolve(server.address().port));
    });
  }

  function close() {
    return new Promise((resolve) => (server ? server.close(() => resolve()) : resolve()));
  }

  return { newPairingCode, getPairing, unpair, addRun, approve, cancel, handle, listen, close };
}

module.exports = { createBridge, STALE_MS, CODE_MS, CODE_MISSES, PROJECT_NAME };
