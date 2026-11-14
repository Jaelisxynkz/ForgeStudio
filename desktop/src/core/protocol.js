'use strict';
// The same Studio protocol the ForgeStudio web workspace uses. The plugin is identical for both.

const PROTOCOL = 1;
const OP_TYPES = ['create', 'set', 'script', 'destroy'];
const VALUE_KINDS = ['string', 'number', 'boolean', 'Vector3', 'Color3', 'UDim2', 'Enum', 'BrickColor'];
const SCRIPT_CLASSES = ['Script', 'LocalScript', 'ModuleScript'];
const MAX_OPERATIONS = 40;
const TREE_LIMIT = 60000;

const PATH = /^[\w .\-]{1,100}(\/[\w .\-]{1,100}){0,12}$/;
const CLASS = /^[A-Za-z0-9]{1,60}$/;
const NAME = /^[^/]{1,100}$/;

function cleanProperties(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((p) => p && typeof p.name === 'string' && /^[A-Za-z0-9]{1,60}$/.test(p.name) && VALUE_KINDS.includes(p.kind) && typeof p.value === 'string' && p.value.length <= 2000)
    .slice(0, 30)
    .map((p) => ({ name: p.name, kind: p.kind, value: p.value }));
}

// Keeps only operations that match the protocol exactly. Anything else is dropped and counted.
function cleanOperations(raw) {
  const operations = [];
  let dropped = 0;
  for (const op of Array.isArray(raw) ? raw : []) {
    if (operations.length >= MAX_OPERATIONS) { dropped += 1; continue; }
    if (!op || !OP_TYPES.includes(op.type)) { dropped += 1; continue; }
    if (op.type === 'create' && CLASS.test(op.class || '') && PATH.test(op.parent || '') && NAME.test(op.name || '') && !SCRIPT_CLASSES.includes(op.class)) {
      operations.push({ type: 'create', class: op.class, parent: op.parent, name: op.name, properties: cleanProperties(op.properties) });
    } else if (op.type === 'set' && PATH.test(op.path || '') && cleanProperties(op.properties).length > 0) {
      operations.push({ type: 'set', path: op.path, properties: cleanProperties(op.properties) });
    } else if (op.type === 'script' && SCRIPT_CLASSES.includes(op.class) && PATH.test(op.parent || '') && NAME.test(op.name || '') && typeof op.source === 'string' && op.source.length > 0 && op.source.length <= 20000) {
      operations.push({ type: 'script', class: op.class, parent: op.parent, name: op.name, source: op.source });
    } else if (op.type === 'destroy' && PATH.test(op.path || '') && op.path.includes('/')) {
      operations.push({ type: 'destroy', path: op.path });
    } else {
      dropped += 1;
    }
  }
  return { operations, dropped };
}

// Rebuilds the tree from plain names and classes only, so nothing else the plugin sends is kept or shown.
function cleanNode(node, depth) {
  if (!node || typeof node !== 'object' || typeof node.n !== 'string' || typeof node.c !== 'string') return null;
  const clean = { n: node.n.slice(0, 60), c: node.c.slice(0, 60) };
  if (Array.isArray(node.k) && depth < 6) {
    const kids = node.k.slice(0, 60).map((kid) => cleanNode(kid, depth + 1)).filter(Boolean);
    if (kids.length > 0) clean.k = kids;
  }
  if (typeof node.more === 'number' && node.more > 0) clean.more = Math.floor(node.more);
  return clean;
}

function cleanTree(tree) {
  if (!tree || typeof tree !== 'object' || !Array.isArray(tree.services)) return null;
  const services = tree.services.slice(0, 20).map((service) => cleanNode(service, 0)).filter(Boolean);
  return JSON.stringify({ services }).length > TREE_LIMIT ? null : { services };
}

const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    reply: { type: 'string' },
    plan: { type: 'array', items: { type: 'string' } },
    operations: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: OP_TYPES },
          class: { type: 'string' },
          parent: { type: 'string' },
          name: { type: 'string' },
          path: { type: 'string' },
          source: { type: 'string' },
          properties: {
            type: 'array',
            items: {
              type: 'object',
              properties: { name: { type: 'string' }, kind: { type: 'string', enum: VALUE_KINDS }, value: { type: 'string' } },
              required: ['name', 'kind', 'value'],
            },
          },
        },
        required: ['type'],
      },
    },
  },
  required: ['reply', 'plan', 'operations'],
};

function buildPrompt({ placeName, tree, history, prompt }) {
  const treeText = tree
    ? 'Instance tree last reported by the Studio plugin (n = name, c = class, k = children; depth and size are capped, so absence here does not prove absence in the place):\n' + JSON.stringify(tree).slice(0, 14000)
    : 'No instance tree has been reported yet, because the Studio plugin has not synced. Do not assume anything exists beyond the standard Roblox services.';
  const past = history.length
    ? history.map((j) => 'Creator: ' + j.prompt + '\nAgent: ' + (j.reply || '').slice(0, 500) + '\nOutcome: ' + j.status).join('\n\n')
    : 'None.';
  return [
    'You are the ForgeStudio build agent for Roblox Studio, working with a solo Roblox creator.',
    'You do not explain how to build things. You return a short plan and a list of structured operations that a Studio plugin applies to the place the creator has open.',
    'Answer with one JSON object with the keys reply, plan and operations.',
    '',
    'Operation types:',
    '- create: { type, class, parent, name, properties } creates one instance. Never use it for scripts.',
    '- script: { type, class, parent, name, source } creates or overwrites a Script, LocalScript or ModuleScript with complete, working Luau.',
    '- set: { type, path, properties } changes properties of an existing instance.',
    '- destroy: { type, path } removes an instance. Use only when the creator clearly asked for a removal.',
    '',
    'Rules:',
    '- Paths use "/" and start at a service, for example Workspace/SpawnArea/Door. Create a parent before its children.',
    '- Each property is { name, kind, value } and value is always a string. kind is one of: ' + VALUE_KINDS.join(', ') + '.',
    '- Formats: Vector3 "x, y, z". Color3 "r, g, b" with 0-255. UDim2 "xScale, xOffset, yScale, yOffset". Enum "Material.Neon". boolean "true" or "false".',
    '- Anchor parts that should not fall. Server logic goes in ServerScriptService, shared modules in ReplicatedStorage, interface in StarterGui.',
    '- At most ' + MAX_OPERATIONS + ' operations per run. If the request is bigger, build the first coherent slice and say in reply exactly what is left.',
    '- Only reference existing instances that appear in the reported tree.',
    '- reply must describe what the operations WILL do once applied. Never say anything was created, tested or verified: nothing has run yet.',
    '- If the creator asked a question rather than for a change, answer it in reply and return an empty operations list.',
    '',
    'Place: ' + (placeName || 'not connected yet'),
    '',
    treeText,
    '',
    'Earlier runs in this place:',
    past,
    '',
    'Creator request:',
    prompt,
  ].join('\n');
}

module.exports = { PROTOCOL, OP_TYPES, VALUE_KINDS, SCRIPT_CLASSES, MAX_OPERATIONS, RESPONSE_SCHEMA, cleanOperations, cleanTree, buildPrompt };
