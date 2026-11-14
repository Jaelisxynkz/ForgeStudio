'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createOllama } = require('../src/core/ollama');
const { fakeOllama, json } = require('../support/http');

test('reports whether Ollama is running and lists installed models', async () => {
  const server = await fakeOllama({
    'GET /api/version': (body, res) => json(res, 200, { version: '0.5.1' }),
    'GET /api/tags': (body, res) => json(res, 200, { models: [{ name: 'qwen2.5-coder:7b', size: 4700000000, details: { parameter_size: '7.6B', quantization_level: 'Q4_K_M' } }] }),
  });
  const ollama = createOllama({ base: server.base });
  assert.deepEqual(await ollama.status(), { running: true, version: '0.5.1' });
  assert.deepEqual(await ollama.list(), [{ name: 'qwen2.5-coder:7b', size: 4700000000, parameters: '7.6B', quantization: 'Q4_K_M' }]);
  await server.close();
  assert.deepEqual(await ollama.status(), { running: false, version: '' }, 'a closed port means not running');
});

test('a download streams progress and only succeeds when Ollama says so', async () => {
  let cut = false;
  const server = await fakeOllama({
    'POST /api/pull': (body, res) => {
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      res.write(JSON.stringify({ status: 'pulling manifest' }) + '\n' + JSON.stringify({ status: 'downloading', total: 100, completed: 40 }).slice(0, 20));
      res.write(JSON.stringify({ status: 'downloading', total: 100, completed: 40 }).slice(20) + '\n');
      res.end(cut ? '' : JSON.stringify({ status: 'success' }));
    },
  });
  const ollama = createOllama({ base: server.base });
  const seen = [];
  await ollama.pull('qwen2.5-coder:3b', (p) => seen.push(p));
  assert.deepEqual(seen, [
    { status: 'pulling manifest', total: 0, completed: 0 },
    { status: 'downloading', total: 100, completed: 40 },
    { status: 'success', total: 0, completed: 0 },
  ]);
  cut = true;
  await assert.rejects(ollama.pull('qwen2.5-coder:3b'), /before it finished/);
  await assert.rejects(ollama.pull('bad name!'), /not a valid model name/);
  await server.close();
});

test('download and removal errors from Ollama are passed on', async () => {
  const removed = [];
  const server = await fakeOllama({
    'POST /api/pull': (body, res) => { res.writeHead(200); res.end(JSON.stringify({ error: 'pull model manifest: file does not exist' }) + '\n'); },
    'DELETE /api/delete': (body, res) => { if (body.model === 'gone:1b') return json(res, 404, { error: "model 'gone:1b' not found" }); removed.push(body.model); json(res, 200, {}); },
  });
  const ollama = createOllama({ base: server.base });
  await assert.rejects(ollama.pull('nope:1b'), /file does not exist/);
  await ollama.remove('qwen2.5-coder:3b');
  assert.deepEqual(removed, ['qwen2.5-coder:3b']);
  await assert.rejects(ollama.remove('gone:1b'), /not found/);
  await server.close();
});

test('an answer is streamed, requested with the schema, and must be complete, usable JSON', async () => {
  let sent = null;
  let events = [];
  const server = await fakeOllama({
    'POST /api/chat': (body, res) => {
      sent = body;
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      res.end(events.map((event) => JSON.stringify(event)).join('\n') + '\n');
    },
  });
  const ollama = createOllama({ base: server.base });
  const schema = { type: 'object' };
  const ask = () => ollama.chatJson({ model: 'qwen2.5-coder:3b', prompt: 'hello', schema });
  const answer = JSON.stringify({ reply: 'Will add a part', plan: ['Add part'], operations: [] });

  events = [{ message: { content: answer.slice(0, 12) } }, { message: { content: answer.slice(12) } }, { message: { content: '' }, done: true, done_reason: 'stop' }];
  assert.deepEqual(await ask(), { reply: 'Will add a part', plan: ['Add part'], operations: [] }, 'the pieces are joined into one answer');
  assert.equal(sent.stream, true, 'streamed, so a slow model is not cut off by a connection timeout');
  assert.equal(sent.options.num_predict, 4096, 'capped, so a model that will not stop cannot run forever');
  assert.deepEqual(sent.format, schema);
  assert.equal(sent.messages[0].content, 'hello');

  events = [{ message: { content: 'Sure! Here is how you would do it...' } }, { done: true, done_reason: 'stop' }];
  await assert.rejects(ask(), /did not return a usable answer/);
  events = [{ message: { content: answer.slice(0, 12) } }, { done: true, done_reason: 'length' }];
  await assert.rejects(ask(), /cut off/);
  events = [{ message: { content: answer } }];
  await assert.rejects(ask(), /before the answer was complete/);
  events = [{ error: 'model requires more system memory' }];
  await assert.rejects(ask(), /more system memory/);
  await server.close();
});
