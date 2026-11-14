'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { cleanOperations, cleanTree, buildPrompt, MAX_OPERATIONS } = require('../src/core/protocol');

test('valid operations pass through with unknown fields stripped', () => {
  const { operations, dropped } = cleanOperations([
    { type: 'create', class: 'Part', parent: 'Workspace', name: 'Floor', evil: 'x', properties: [{ name: 'Anchored', kind: 'boolean', value: 'true', extra: 1 }] },
    { type: 'script', class: 'Script', parent: 'ServerScriptService', name: 'Main', source: 'print("hi")', run: true },
    { type: 'set', path: 'Workspace/Floor', properties: [{ name: 'Size', kind: 'Vector3', value: '10, 1, 10' }] },
    { type: 'destroy', path: 'Workspace/Floor' },
  ]);
  assert.equal(dropped, 0);
  assert.deepEqual(operations[0], { type: 'create', class: 'Part', parent: 'Workspace', name: 'Floor', properties: [{ name: 'Anchored', kind: 'boolean', value: 'true' }] });
  assert.deepEqual(operations[1], { type: 'script', class: 'Script', parent: 'ServerScriptService', name: 'Main', source: 'print("hi")' });
  assert.deepEqual(Object.keys(operations[3]), ['type', 'path']);
});

test('operations outside the protocol are dropped and counted', () => {
  const { operations, dropped } = cleanOperations([
    { type: 'create', class: 'Script', parent: 'Workspace', name: 'Sneaky' },
    { type: 'destroy', path: 'Workspace' },
    { type: 'set', path: 'Workspace/Floor', properties: [{ name: 'Size', kind: 'Function', value: 'x' }] },
    { type: 'script', class: 'Script', parent: 'Workspace', name: 'Empty', source: '' },
    { type: 'script', class: 'Script', parent: 'Workspace', name: 'Huge', source: 'x'.repeat(20001) },
    { type: 'run', code: 'os.exit()' },
    { type: 'create', class: 'Part', parent: 'Workspace/a;b', name: 'Bad' },
    null,
    'create',
  ]);
  assert.equal(operations.length, 0);
  assert.equal(dropped, 9);
});

test('a run is capped at the protocol limit', () => {
  const many = Array.from({ length: MAX_OPERATIONS + 5 }, (_, i) => ({ type: 'create', class: 'Part', parent: 'Workspace', name: 'P' + i }));
  const { operations, dropped } = cleanOperations(many);
  assert.equal(operations.length, MAX_OPERATIONS);
  assert.equal(dropped, 5);
  assert.deepEqual(cleanOperations('nope'), { operations: [], dropped: 0 });
});

test('the reported tree keeps only names, classes and counts', () => {
  const tree = cleanTree({ services: [{ n: 'Workspace', c: 'Workspace', secret: 'x', k: [{ n: 'A'.repeat(200), c: 'Part', source: 'leak' }, { c: 'NoName' }], more: 3.7 }], nodes: 2, other: true });
  assert.deepEqual(tree, { services: [{ n: 'Workspace', c: 'Workspace', k: [{ n: 'A'.repeat(60), c: 'Part' }], more: 3 }] });
  assert.equal(cleanTree({ services: 'x' }), null);
  assert.equal(cleanTree(null), null);
});

test('the prompt carries the place, its tree and earlier runs', () => {
  const prompt = buildPrompt({ placeName: 'Obby', tree: { services: [{ n: 'Workspace', c: 'Workspace' }] }, history: [{ prompt: 'add a door', reply: 'Will add a door', status: 'completed' }], prompt: 'make it red' });
  assert.match(prompt, /Place: Obby/);
  assert.match(prompt, /"n":"Workspace"/);
  assert.match(prompt, /Creator: add a door/);
  assert.match(prompt, /make it red$/);
  assert.match(buildPrompt({ placeName: '', tree: null, history: [], prompt: 'x' }), /No instance tree has been reported yet/);
});
