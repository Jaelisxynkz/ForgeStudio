'use strict';
(function () {
  const api = window.forge;
  const $ = (id) => document.getElementById(id);
  let state = null;
  let hardware = null;
  let ollama = { running: false, version: '', models: [] };
  const pulls = {};
  const openSource = new Set();
  const seen = {};
  const ui = { tab: 'build', sending: false, runCount: 0, buildError: '', modelsError: '', studioMessage: '', studioError: '', accountError: '' };

  const STATUS = {
    waiting_for_desktop: 'Waiting for a desktop app', generating: 'Planning on this computer',
    awaiting_approval: 'Waiting for your approval', queued: 'Waiting for Studio', running: 'Running in Studio',
    completed: 'Completed', failed: 'Failed', cancelled: 'Cancelled', answered: 'Answered',
  };
  const OP_LABEL = { create: 'Create', script: 'Script', set: 'Edit', destroy: 'Remove' };

  // Builds elements with text set as text, never as markup, so nothing a model or Studio sends can inject content.
  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    for (const [key, value] of Object.entries(props || {})) {
      if (value === false || value === null || value === undefined) continue;
      if (key === 'class') el.className = value;
      else if (key === 'text') el.textContent = value;
      else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
      else el.setAttribute(key, value === true ? '' : value);
    }
    for (const kid of kids.flat()) if (kid) el.append(kid);
    return el;
  }

  const message = (error) => String((error && error.message) || error).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  const gb = (bytes) => (bytes / 1e9).toFixed(1) + ' GB';
  const time = (value) => new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const online = () => Boolean(state.paired && state.lastSeen && Date.now() - Date.parse(state.lastSeen) < 20000);
  const installed = (name) => ollama.models.some((model) => model.name === name);

  // Re-draws a region only when what it shows has changed, so scrolling and open sections stay put.
  function draw(id, data, build) {
    const key = JSON.stringify(data);
    if (seen[id] === key) return;
    seen[id] = key;
    $(id).replaceChildren(...[].concat(build()).filter(Boolean));
  }

  function drawStatus() {
    const studio = !state.paired ? ['off', 'Studio not paired'] : online() ? ['on', 'Studio connected'] : ['warn', 'Studio offline'];
    $('dot-studio').className = 'dot ' + studio[0];
    $('txt-studio').textContent = studio[1];
    $('dot-ollama').className = 'dot ' + (ollama.running ? 'on' : 'off');
    $('txt-ollama').textContent = ollama.running ? 'Ollama running' : 'Ollama not found';
    $('version').textContent = 'Version ' + state.version;
  }

  function describe(op) {
    const props = (op.properties || []).map((p) => p.name + ' = ' + p.value).join(' · ');
    if (op.type === 'create') return props ? op.class + ' · ' + props : op.class;
    if (op.type === 'script') return op.class + ' · ' + op.source.split('\n').length + ' lines · replaces a script with this name if one exists';
    if (op.type === 'set') return props;
    return 'Removes this instance from the place';
  }

  function opRow(run, op, index) {
    const key = run.id + ':' + index;
    const result = run.results[index];
    const target = op.type === 'create' || op.type === 'script' ? op.parent + '/' + op.name : op.path;
    const toggle = () => {
      if (openSource.has(key)) openSource.delete(key); else openSource.add(key);
      render();
    };
    let outcome = null;
    if (result) {
      const tail = !result.ok ? '' : result.verified ? ' · read back and confirmed' : ' · applied, not confirmed on read-back';
      outcome = h('p', { class: 'small ' + (!result.ok ? 'bad' : result.verified ? 'good' : 'warn'), text: 'Studio: ' + (result.message || (result.ok ? 'applied' : 'failed')) + tail });
    }
    return h('div', { class: 'op' },
      h('span', { class: 'op-type ' + op.type, text: OP_LABEL[op.type] }),
      h('div', { class: 'op-body' },
        h('p', { class: 'mono small', text: target }),
        h('p', { class: 'muted small', text: describe(op) }),
        op.type === 'script' && h('button', { class: 'link', type: 'button', text: openSource.has(key) ? 'Hide source' : 'View source', onclick: toggle }),
        op.type === 'script' && openSource.has(key) && h('pre', { text: op.source }),
        outcome));
  }

  function note(run) {
    if (run.status === 'awaiting_approval') return 'Nothing changes in your place until you approve.';
    if (run.status === 'queued') return online() ? 'Studio will pick this up within a few seconds.' : 'Waiting for Roblox Studio to connect.';
    if (run.status === 'failed') return run.error;
    if (run.status !== 'completed') return '';
    const unconfirmed = run.results.filter((r) => r.ok && !r.verified).length;
    const readBack = unconfirmed > 0
      ? unconfirmed + ' of ' + run.results.length + ' changes were applied but not confirmed when Studio read them back.'
      : 'Studio read every change back and confirmed it.';
    return readBack + ' ' + (run.undoRecorded ? 'Studio recorded this run as one undo step.' : 'Studio did not confirm an undo step for this run.');
  }

  function act(promise) {
    ui.buildError = '';
    promise.catch((error) => { ui.buildError = message(error); render(); });
  }

  function runCard(run) {
    const awaiting = run.status === 'awaiting_approval';
    const text = note(run);
    return h('article', { class: 'run' },
      h('div', { class: 'run-head' },
        h('span', { class: 'badge ' + run.status, text: STATUS[run.status] }),
        h('span', { class: 'muted small', text: time(run.createdAt) + (run.model ? ' · ' + run.model : '') })),
      h('p', { class: 'prompt', text: run.prompt }),
      run.reply && h('p', { class: 'reply', text: run.reply }),
      run.plan.length > 0 && h('ol', { class: 'plan' }, run.plan.map((step) => h('li', { text: step }))),
      run.operations.length > 0 && h('div', { class: 'ops' }, run.operations.map((op, index) => opRow(run, op, index))),
      text && h('p', { class: 'small ' + (run.status === 'failed' ? 'bad' : 'muted'), text }),
      (awaiting || run.status === 'queued') && h('div', { class: 'actions' },
        awaiting && h('button', { class: 'primary', type: 'button', text: 'Approve and send to Studio', onclick: () => act(api.approve(run.id)) }),
        h('button', { type: 'button', text: 'Cancel', onclick: () => act(api.cancel(run.id)) })));
  }

  function drawBuild() {
    const model = state.settings.model;
    const notices = [];
    if (state.bridgeError) notices.push(state.bridgeError);
    if (!ollama.running) notices.push('Ollama is not running. Open the Models page to set it up.');
    else if (!model) notices.push('Choose a model on the Models page before sending a request.');
    else if (!installed(model)) notices.push('The chosen model, ' + model + ', is not installed any more. Pick another on the Models page.');
    if (!state.paired) notices.push('Roblox Studio is not paired yet. Open the Roblox Studio page to connect it.');
    if (state.account.signedIn && !state.account.projectId) notices.push('Choose a project on the Account page to share this conversation with the website.');
    if (state.account.error) notices.push(state.account.error);
    const project = state.account.projects.find((p) => p.id === state.account.projectId);
    $('build-eyebrow').textContent = project ? 'Shared project · ' + project.name : 'Runs on this computer';
    draw('build-notices', notices, () => notices.map((text) => h('p', { class: 'notice', text })));

    draw('runs', [state.runs, Array.from(openSource), online()], () => (state.runs.length > 0
      ? state.runs.map(runCard)
      : h('p', { class: 'muted empty', text: 'No runs yet. Describe something to build, for example: add a glowing checkpoint pad next to the spawn.' })));
    if (state.runs.length !== ui.runCount) {
      ui.runCount = state.runs.length;
      $('runs').scrollTop = $('runs').scrollHeight;
    }

    $('send').disabled = ui.sending || !ollama.running || !model;
    const status = $('composer-note');
    status.className = 'small ' + (ui.buildError ? 'bad' : 'muted');
    status.textContent = ui.buildError || (ui.sending ? 'The model is working on this computer. Larger models can take a few minutes.' : model ? 'Using ' + model : '');
  }

  const progress = (p) => (p.total > 0 ? Math.floor((p.completed / p.total) * 100) + '% · ' : '') + p.status;

  function startPull(name) {
    ui.modelsError = '';
    pulls[name] = { status: 'Starting', total: 0, completed: 0 };
    render();
    api.pull(name)
      .then(() => (state.settings.model ? null : api.setSettings({ model: name })))
      .catch((error) => { ui.modelsError = message(error); })
      .then(() => { delete pulls[name]; return refreshOllama(); });
  }

  function removeModel(name) {
    if (!window.confirm('Remove ' + name + ' from this computer? You can download it again later.')) return;
    ui.modelsError = '';
    api.removeModel(name).catch((error) => { ui.modelsError = message(error); }).then(refreshOllama);
  }

  function drawModels() {
    draw('hardware', hardware, () => h('p', { class: 'muted', text: 'This computer has ' + hardware.ramGb + ' GB of memory and ' + hardware.cores + ' processor cores. Suggested model: ' + hardware.recommended + '.' }));
    draw('ollama-box', [ollama.running, ollama.version], () => (ollama.running
      ? h('p', { class: 'good small', text: 'Ollama ' + ollama.version + ' is running. Models and answers stay on this computer.' })
      : h('div', { class: 'card' },
        h('p', { text: 'ForgeStudio runs models through Ollama, a free open-source program. It is not installed or not running.' }),
        h('p', { class: 'muted small', text: 'Install it and this page updates by itself once it is running.' }),
        h('button', { class: 'primary', type: 'button', text: 'Get Ollama', onclick: () => api.openOllama() }))));

    draw('installed', [ollama, state.settings.model], () => (ollama.models.length === 0
      ? h('p', { class: 'muted', text: ollama.running ? 'No models installed yet. Download one below.' : 'Models appear here once Ollama is running.' })
      : ollama.models.map((model) => h('div', { class: 'item' },
        h('div', null,
          h('p', { class: 'mono', text: model.name }),
          h('p', { class: 'muted small', text: [gb(model.size), model.parameters, model.quantization].filter(Boolean).join(' · ') })),
        h('div', { class: 'actions' },
          model.name === state.settings.model
            ? h('span', { class: 'good small', text: 'Used for builds' })
            : h('button', { type: 'button', text: 'Use for builds', onclick: () => api.setSettings({ model: model.name }) }),
          h('button', { type: 'button', text: 'Remove', onclick: () => removeModel(model.name) }))))));

    draw('catalog', [hardware, ollama, Object.keys(pulls)], () => hardware.catalog.map((model) => h('div', { class: 'item' },
      h('div', null,
        h('p', { class: 'mono', text: model.name + (model.name === hardware.recommended ? '  · suggested for this computer' : '') }),
        h('p', { class: 'muted small', text: 'About ' + model.sizeGb + ' GB · ' + model.note + (model.fits ? '' : ' Needs about ' + model.minRamGb + ' GB of memory.') })),
      h('div', { class: 'actions' },
        installed(model.name) ? h('span', { class: 'good small', text: 'Installed' })
          : pulls[model.name] ? h('span', { class: 'muted small', text: 'Downloading' })
            : h('button', { type: 'button', text: 'Download', disabled: !ollama.running, onclick: () => startPull(model.name) })))));

    draw('pulling', pulls, () => Object.entries(pulls).map(([name, p]) => h('p', { class: 'muted small', text: name + ': ' + progress(p) })));
    $('models-error').textContent = ui.modelsError;
  }

  function step(number, title, kids) {
    return h('div', { class: 'step' }, h('span', { class: 'step-number', text: number }), h('div', { class: 'step-body' }, h('h3', { text: title }), kids));
  }

  function studioAction(promise, done) {
    ui.studioError = '';
    ui.studioMessage = '';
    promise.then((value) => { ui.studioMessage = done ? done(value) : ''; }).catch((error) => { ui.studioError = message(error); }).then(render);
  }

  function treeNode(node) {
    return h('li', null,
      h('span', { text: node.n }),
      h('span', { class: 'muted small', text: '  ' + node.c }),
      node.k && h('ul', null, node.k.map(treeNode)),
      node.more && h('p', { class: 'muted small', text: node.more + ' more not shown' }));
  }

  function drawStudio() {
    draw('studio-steps', [state.paired, state.place, online(), state.pairing, state.pluginsDir, state.bridgeError, ui.studioMessage, ui.studioError], () => [
      state.bridgeError && h('p', { class: 'notice', text: state.bridgeError }),
      step('1', 'Install the plugin', [
        h('p', { class: 'muted', text: state.pluginsDir
          ? 'Copies the ForgeStudio plugin into ' + state.pluginsDir + ', set to talk to this app only. It replaces a ForgeStudio plugin downloaded from the website. Restart Roblox Studio afterwards.'
          : 'Roblox Studio only runs on Windows and macOS, so the plugin cannot be installed on this computer.' }),
        h('button', { class: 'primary', type: 'button', text: 'Install plugin', disabled: !state.pluginsDir, onclick: () => studioAction(api.installPlugin(), (file) => 'Installed to ' + file + '. Restart Roblox Studio to load it.') }),
        ui.studioMessage && h('p', { class: 'good small', text: ui.studioMessage }),
      ]),
      step('2', 'Pair your place', [
        h('p', { class: 'muted', text: 'Open your place in Studio, click ForgeStudio in the Plugins tab and type this code into its panel.' }),
        state.pairing && h('p', { class: 'code', text: state.pairing.code }),
        state.pairing && h('p', { class: 'muted small', text: 'Works once and expires at ' + time(state.pairing.expires) + '.' }),
        h('button', { type: 'button', text: state.pairing ? 'New code' : 'Show pairing code', onclick: () => studioAction(api.newCode()) }),
      ]),
      step('3', 'Connection', state.paired ? [
        h('p', { text: 'Paired with ' + ((state.place && state.place.name) || 'your place') + (state.place && state.place.pluginVersion ? ' · plugin ' + state.place.pluginVersion : '') }),
        h('p', { class: 'small ' + (online() ? 'good' : 'warn'), text: online() ? 'Studio is connected and checking in.' : 'Studio is not checking in. Open the place in Studio to reconnect.' }),
        h('button', { type: 'button', text: 'Disconnect', onclick: () => studioAction(api.unpair()) }),
      ] : [h('p', { class: 'muted', text: 'Not paired yet.' })]),
      ui.studioError && h('p', { class: 'bad small', text: ui.studioError }),
    ]);

    draw('tree', state.tree, () => (state.tree
      ? h('ul', { class: 'tree' }, state.tree.services.map(treeNode))
      : h('p', { class: 'muted', text: 'Nothing reported yet. The plugin sends the contents of your place shortly after pairing.' })));
  }

  function accountAction(promise) {
    ui.accountError = '';
    promise.catch((error) => { ui.accountError = message(error); }).then(render);
  }

  function drawAccount() {
    const account = state.account;
    draw('account-box', [account, ui.accountError], () => (account.signedIn ? [
      h('p', { class: 'good', text: 'Signed in' + (account.name ? ' as ' + account.name : '') + '.' }),
      h('p', { class: 'muted small', text: 'Requests typed on the website for a project set to plan on your computer are collected by this app and answered by your chosen model.' }),
      h('h2', { text: 'Projects' }),
      account.projects.length === 0 && h('p', { class: 'muted', text: 'No projects yet. Create one on the ForgeStudio website and it appears here.' }),
      account.projects.map((p) => h('div', { class: 'item' },
        h('div', null,
          h('p', { text: p.name }),
          h('p', { class: 'muted small', text: p.planning === 'local' ? 'Website requests are planned on your computer' : 'Website requests are planned by the hosted model' })),
        h('div', { class: 'actions' }, p.id === account.projectId
          ? h('span', { class: 'good small', text: 'Open on the Build page' })
          : h('button', { type: 'button', text: 'Open', onclick: () => accountAction(api.chooseProject(p.id)) })))),
      account.projectId && h('button', { type: 'button', text: 'Close the shared project', onclick: () => accountAction(api.chooseProject('')) }),
      h('h2', { text: 'This computer' }),
      h('button', { type: 'button', text: 'Sign out', onclick: () => accountAction(api.signOut()) }),
      ui.accountError && h('p', { class: 'bad small', text: ui.accountError }),
    ] : [
      h('p', { class: 'muted', text: 'Sign in to share projects and conversations with the ForgeStudio website, and to let requests typed on the website be planned by a model on this computer. Without signing in, everything stays on this computer.' }),
      account.pending && h('p', { text: 'Approve this code in the browser window that just opened:' }),
      account.pending && h('p', { class: 'code', text: account.pending.userCode }),
      account.pending && h('p', { class: 'muted small', text: 'Approve it only while signed in to your own ForgeStudio account. It expires at ' + time(account.pending.expires) + '.' }),
      account.pending
        ? h('button', { type: 'button', text: 'Open the approval page again', onclick: () => accountAction(api.openApproval()) })
        : h('button', { class: 'primary', type: 'button', text: 'Sign in', onclick: () => accountAction(api.signIn()) }),
      (ui.accountError || account.error) && h('p', { class: 'bad small', text: ui.accountError || account.error }),
    ]));
  }

  function render() {
    if (!state || !hardware) return;
    for (const name of ['build', 'models', 'studio', 'account']) $('view-' + name).hidden = ui.tab !== name;
    document.querySelectorAll('nav button').forEach((button) => button.classList.toggle('active', button.dataset.tab === ui.tab));
    drawStatus();
    drawBuild();
    drawModels();
    drawStudio();
    drawAccount();
  }

  function refreshOllama() {
    return api.ollamaInfo().then((info) => { ollama = info; render(); });
  }

  async function init() {
    state = await api.state();
    hardware = await api.hardware();
    api.onState((next) => { state = next; render(); });
    api.onPull((p) => { if (pulls[p.name]) { pulls[p.name] = p; render(); } });

    document.querySelectorAll('nav button').forEach((button) => button.addEventListener('click', () => { ui.tab = button.dataset.tab; render(); }));
    $('permission').value = state.settings.permission;
    $('permission').addEventListener('change', (event) => api.setSettings({ permission: event.target.value }));
    $('composer').addEventListener('submit', (event) => {
      event.preventDefault();
      const text = $('prompt').value.trim();
      if (!text || ui.sending) return;
      ui.sending = true;
      ui.buildError = '';
      render();
      api.runAgent(text)
        .then(() => { $('prompt').value = ''; })
        .catch((error) => { ui.buildError = message(error); })
        .then(() => { ui.sending = false; render(); });
    });
    $('pull-form').addEventListener('submit', (event) => {
      event.preventDefault();
      const name = $('pull-name').value.trim();
      if (!name || pulls[name]) return;
      $('pull-name').value = '';
      startPull(name);
    });

    render();
    document.body.dataset.ready = 'true';
    refreshOllama();
    setInterval(refreshOllama, 4000);
  }

  init();
}());
