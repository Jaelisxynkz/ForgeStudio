'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runAgent } = require('../src/core/agent');
const { recommend } = require('../src/core/hardware');
const { pluginsDir, buildPlugin, installPlugin } = require('../src/core/plugin');
const store = require('../src/core/store');
const { createBridge } = require('../src/core/bridge');

const PLUGIN = path.join(__dirname, '..', '..', 'plugin', 'ForgeStudio.plugin.luau');
const ENDPOINT = 'http://127.0.0.1:47771/pluginBridge';
const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'forge-test-'));

test('a local model answer becomes a reviewed run, with bad operations left out', async () => {
  const state = store.defaults();
  state.place = { name: 'Obby' };
  let asked = null;
  const ollama = {
    chatJson: async (request) => {
      asked = request;
      return {
        reply: '  Will add a checkpoint.  ',
        plan: ['Add the part', '', 7, ' Anchor it '],
        operations: [
          { type: 'create', class: 'Part', parent: 'Workspace', name: 'Checkpoint' },
          { type: 'create', class: 'Script', parent: 'Workspace', name: 'Sneaky' },
          { type: 'shell', command: 'rm -rf' },
        ],
      };
    },
  };
  const result = await runAgent({ ollama, model: 'qwen2.5-coder:3b', state, prompt: 'add a checkpoint' });
  assert.equal(asked.model, 'qwen2.5-coder:3b');
  assert.match(asked.prompt, /Place: Obby/);
  assert.deepEqual(result.plan, ['Add the part', 'Anchor it']);
  assert.equal(result.operations.length, 1);
  assert.match(result.reply, /^Will add a checkpoint\.\n\n2 proposed operation\(s\) did not match/);

  const run = createBridge({ state }).addRun({ ...result, permission: 'review' });
  assert.equal(run.status, 'awaiting_approval');
  assert.equal(run.model, 'qwen2.5-coder:3b');
});

test('a model that returns nothing usable produces an answer with no operations', async () => {
  const result = await runAgent({ ollama: { chatJson: async () => ({ reply: 5, plan: 'x', operations: 'y' }) }, model: 'm', state: store.defaults(), prompt: 'hi' });
  assert.deepEqual(result, { prompt: 'hi', reply: '', plan: [], operations: [], model: 'm' });
});

test('the suggested model follows the memory in this computer', () => {
  const gb = 1024 ** 3;
  assert.equal(recommend(2 * gb, 2).recommended, 'qwen2.5-coder:1.5b');
  assert.equal(recommend(8 * gb, 4).recommended, 'qwen2.5-coder:3b');
  assert.equal(recommend(16 * gb, 8).recommended, 'qwen2.5-coder:7b');
  assert.equal(recommend(128 * gb, 32).recommended, 'qwen2.5-coder:32b');
  const laptop = recommend(8 * gb, 4);
  assert.deepEqual(laptop.catalog.map((m) => m.fits), [true, true, false, false, false]);
  assert.equal(laptop.ramGb, 8);
});

test('the bundled plugin is pointed at this computer and nowhere else', () => {
  const source = fs.readFileSync(PLUGIN, 'utf8');
  const built = buildPlugin(source, ENDPOINT);
  assert.ok(built.includes('local ENDPOINT = "' + ENDPOINT + '"'));
  assert.ok(!built.includes('__ENDPOINT__'));
  assert.equal(built.length, source.length - '__ENDPOINT__'.length + ENDPOINT.length);
  assert.throws(() => buildPlugin(source, 'https://example.com/functions/pluginBridge'), /only be pointed at this computer/);
  assert.throws(() => buildPlugin(source, 'http://127.0.0.1.evil.com:80/pluginBridge'), /only be pointed at this computer/);
  assert.throws(() => buildPlugin('print("x")', ENDPOINT), /missing its address placeholder/);
});

test('the plugin installs into the Roblox plugins folder for each system', () => {
  assert.equal(pluginsDir('win32', { LOCALAPPDATA: 'C:/Users/me/AppData/Local' }, '/home/me'), path.join('C:/Users/me/AppData/Local', 'Roblox', 'Plugins'));
  assert.equal(pluginsDir('win32', {}, '/home/me'), null);
  assert.equal(pluginsDir('darwin', {}, '/Users/me'), path.join('/Users/me', 'Documents', 'Roblox', 'Plugins'));
  assert.equal(pluginsDir('linux', {}, '/home/me'), null);

  const dir = path.join(temp(), 'Roblox', 'Plugins');
  const file = installPlugin({ source: fs.readFileSync(PLUGIN, 'utf8'), endpoint: ENDPOINT, dir });
  assert.equal(path.basename(file), 'ForgeStudio.lua');
  assert.ok(fs.readFileSync(file, 'utf8').includes(ENDPOINT));
  assert.throws(() => installPlugin({ source: 'x', endpoint: ENDPOINT, dir: null }), /only supported on Windows and macOS/);
});

test('saved work survives a restart, and an interrupted run is failed rather than re-sent', () => {
  const file = path.join(temp(), 'forgestudio.json');
  assert.deepEqual(store.load(file), store.defaults());

  const state = store.defaults();
  const bridge = createBridge({ state });
  const { code } = bridge.newPairingCode();
  const token = bridge.handle({ action: 'pair', code, placeName: 'Obby', placeId: '1', pluginVersion: '0.2.0' }).json.token;
  const part = { type: 'create', class: 'Part', parent: 'Workspace', name: 'A', properties: [] };
  const waiting = bridge.addRun({ prompt: 'one', reply: '', plan: [], operations: [part], model: 'm', permission: 'review' });
  const flying = bridge.addRun({ prompt: 'two', reply: '', plan: [], operations: [part], model: 'm', permission: 'automatic' });
  bridge.handle({ action: 'poll', token });
  assert.equal(flying.status, 'running');
  state.settings = { model: 'qwen2.5-coder:3b', permission: 'automatic' };
  store.save(file, state);

  const loaded = store.load(file);
  assert.equal(loaded.settings.model, 'qwen2.5-coder:3b');
  assert.equal(loaded.settings.permission, 'automatic');
  assert.equal(loaded.place.name, 'Obby');
  assert.equal(loaded.runs.find((r) => r.id === waiting.id).status, 'awaiting_approval');
  const interrupted = loaded.runs.find((r) => r.id === flying.id);
  assert.equal(interrupted.status, 'failed');
  assert.equal(interrupted.error, store.INTERRUPTED);

  const again = createBridge({ state: loaded });
  assert.equal(again.handle({ action: 'poll', token }).json.job, null, 'the old pairing still works and nothing is re-sent');

  fs.writeFileSync(file, '{ broken');
  assert.deepEqual(store.load(file), store.defaults());
});
