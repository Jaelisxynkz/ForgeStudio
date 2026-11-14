'use strict';
// Runs against a real Ollama with a real model: nothing here is a stand-in. It downloads a small public model, so it
// is skipped unless FORGE_REAL_OLLAMA=1. The build pipeline runs it on every change.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createOllama } = require('../src/core/ollama');
const { runAgent } = require('../src/core/agent');
const { OP_TYPES } = require('../src/core/protocol');
const store = require('../src/core/store');

const ENABLED = process.env.FORGE_REAL_OLLAMA === '1';
const MODEL = process.env.FORGE_REAL_MODEL || 'qwen2.5-coder:0.5b';

test('a real model downloaded through Ollama answers a real build request', { skip: ENABLED ? false : 'set FORGE_REAL_OLLAMA=1 to run against a real Ollama', timeout: 20 * 60 * 1000 }, async () => {
  const ollama = createOllama();
  const status = await ollama.status();
  assert.equal(status.running, true, 'Ollama is running');
  assert.match(status.version, /\d+\.\d+/);

  const has = async () => (await ollama.list()).some((model) => model.name === MODEL);
  if (await has()) await ollama.remove(MODEL);
  assert.equal(await has(), false, 'the model starts out absent');
  let events = 0;
  let bytes = 0;
  await ollama.pull(MODEL, (progress) => { events += 1; bytes = Math.max(bytes, progress.completed); });
  assert.ok(events > 1, 'the download streamed progress');
  assert.ok(bytes > 100 * 1024 * 1024, 'real model data was downloaded (' + bytes + ' bytes)');
  assert.equal(await has(), true, 'the model is installed');

  const started = Date.now();
  const result = await runAgent({ ollama, model: MODEL, state: store.defaults(), prompt: 'Create one anchored Part named Beacon in Workspace.' });
  console.log('model: ' + MODEL + ' on Ollama ' + status.version + ', answered in ' + Math.round((Date.now() - started) / 1000) + 's');
  console.log('answer: ' + JSON.stringify(result).slice(0, 2000));
  assert.equal(typeof result.reply, 'string');
  assert.ok(Array.isArray(result.plan) && Array.isArray(result.operations));
  assert.ok(result.reply.length > 0 || result.plan.length > 0 || result.operations.length > 0, 'the model produced content');
  for (const op of result.operations) assert.ok(OP_TYPES.includes(op.type), 'only protocol operations survive');

  await assert.rejects(ollama.chatJson({ model: 'forge-missing-model:1b', prompt: 'hi', schema: { type: 'object' } }), /Ollama/, 'a model that is not installed is a clear error');
  await ollama.remove(MODEL);
  assert.equal(await has(), false, 'the model can be removed again');
});
