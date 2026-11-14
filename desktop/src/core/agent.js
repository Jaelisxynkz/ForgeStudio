'use strict';
const { RESPONSE_SCHEMA, buildPrompt, cleanOperations } = require('./protocol');

// Asks the local model for a plan and operations, then keeps only what matches the Studio protocol.
async function runAgent({ ollama, model, state, prompt }) {
  const result = await ollama.chatJson({
    model,
    schema: RESPONSE_SCHEMA,
    prompt: buildPrompt({ placeName: state.place && state.place.name, tree: state.tree, history: state.runs.slice(-4), prompt }),
  });
  const { operations, dropped } = cleanOperations(result.operations);
  const plan = (Array.isArray(result.plan) ? result.plan : [])
    .filter((step) => typeof step === 'string' && step.trim())
    .slice(0, 12)
    .map((step) => step.trim().slice(0, 300));
  let reply = typeof result.reply === 'string' ? result.reply.trim().slice(0, 4000) : '';
  if (dropped > 0) reply += '\n\n' + dropped + ' proposed operation(s) did not match the Studio protocol and were left out.';
  return { prompt, reply, plan, operations, model };
}

module.exports = { runAgent };
