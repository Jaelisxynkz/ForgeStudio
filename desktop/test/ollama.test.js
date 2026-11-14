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

test('an answer is requested with the schema and must be usable JSON', async () => {
  let sent = null;
  let content = JSON.stringify({ reply: 'Will add a part', plan: ['Add part'], operations: [] });
  const server = await fakeOllama({
    'POST /api/chat': (body, res) => { sent = body; json(res, 200, { message: { role: 'assistant', content } }); },
  });
  const ollama = createOllama({ base: server.base });
  const schema = { type: 'object' };
  assert.deepEqual(await ollama.chatJson({ model: 'qwen2.5-coder:3b', prompt: 'hello', schema }), { reply: 'Will add a part', plan: ['Add part'], operations: [] });
  assert.equal(sent.stream, false);
  assert.deepEqual(sent.format, schema);
  assert.equal(sent.messages[0].content, 'hello');
  content = 'Sure! Here is how you would do it...';
  await assert.rejects(ollama.chatJson({ model: 'qwen2.5-coder:3b', prompt: 'hello', schema }), /did not return a usable answer/);
  await server.close();
});
