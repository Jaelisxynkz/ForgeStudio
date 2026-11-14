'use strict';
const os = require('os');

// Free coding models from the Ollama library. Sizes are approximate download sizes.
const CATALOG = [
  { name: 'qwen2.5-coder:1.5b', sizeGb: 1.0, minRamGb: 4, note: 'Fastest. Fine for small edits, weak on long scripts.' },
  { name: 'qwen2.5-coder:3b', sizeGb: 1.9, minRamGb: 8, note: 'A good balance for laptops.' },
  { name: 'qwen2.5-coder:7b', sizeGb: 4.7, minRamGb: 16, note: 'Noticeably better scripts.' },
  { name: 'qwen2.5-coder:14b', sizeGb: 9.0, minRamGb: 32, note: 'Strong results, needs a powerful computer.' },
  { name: 'qwen2.5-coder:32b', sizeGb: 20, minRamGb: 64, note: 'Best of this family, workstation only.' },
];

function recommend(totalBytes = os.totalmem(), cores = os.cpus().length) {
  const ramGb = Math.round(totalBytes / 1024 ** 3);
  const fitting = CATALOG.filter((model) => model.minRamGb <= ramGb);
  const pick = fitting.length > 0 ? fitting[fitting.length - 1] : CATALOG[0];
  return { ramGb, cores, recommended: pick.name, catalog: CATALOG.map((model) => ({ ...model, fits: model.minRamGb <= ramGb })) };
}

module.exports = { recommend, CATALOG };
