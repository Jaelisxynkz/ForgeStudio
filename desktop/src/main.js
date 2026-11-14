'use strict';
const { app, BrowserWindow, ipcMain, shell } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createBridge } = require('./core/bridge');
const { createOllama, MODEL_NAME } = require('./core/ollama');
const { runAgent } = require('./core/agent');
const { recommend } = require('./core/hardware');
const { pluginsDir, installPlugin } = require('./core/plugin');
const store = require('./core/store');

// Fixed, because the address is written into the plugin file that Studio loads.
const PORT = 47771;
const ENDPOINT = 'http://127.0.0.1:' + PORT + '/pluginBridge';
// --smoke starts the real app, checks it is alive and exits. The build pipeline runs it on every installer.
const SMOKE = process.argv.includes('--smoke');
const PLUGIN_FILE = app.isPackaged
  ? path.join(process.resourcesPath, 'plugin', 'ForgeStudio.plugin.luau')
  : path.join(__dirname, '..', '..', 'plugin', 'ForgeStudio.plugin.luau');

if (SMOKE) {
  app.disableHardwareAcceleration();
  app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'forgestudio-smoke-')));
}

const ollama = createOllama();
let win = null;
let bridge = null;
let state = null;
let bridgeError = '';
let saveTimer = null;

const stateFile = () => path.join(app.getPath('userData'), 'forgestudio.json');

function view() {
  return {
    version: app.getVersion(),
    bridgeError,
    paired: Boolean(state.tokenHash),
    place: state.place,
    lastSeen: state.lastSeen,
    tree: state.tree,
    runs: state.runs.slice(-50),
    settings: state.settings,
    pairing: bridge.getPairing(),
    pluginsDir: pluginsDir(),
  };
}

function changed() {
  if (win && !win.isDestroyed()) win.webContents.send('state', view());
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => store.save(stateFile(), state), 400);
}

// Only this app's own window may call these.
function on(channel, handler) {
  ipcMain.handle(channel, (event, ...args) => {
    if (!win || event.sender !== win.webContents) throw new Error('Not allowed');
    return handler(...args);
  });
}

function registerIpc() {
  on('state:get', () => view());
  on('hardware:get', () => recommend());
  on('ollama:info', async () => {
    const info = await ollama.status();
    return { ...info, models: info.running ? await ollama.list() : [] };
  });
  on('ollama:pull', (name) => ollama.pull(name, (progress) => {
    if (win && !win.isDestroyed()) win.webContents.send('pull', { name, ...progress });
  }));
  on('ollama:remove', async (name) => {
    await ollama.remove(name);
    if (state.settings.model === name) {
      state.settings.model = '';
      changed();
    }
  });
  on('ollama:download-page', () => shell.openExternal('https://ollama.com/download'));
  on('settings:set', (settings) => {
    const next = settings && typeof settings === 'object' ? settings : {};
    if (typeof next.model === 'string' && (next.model === '' || MODEL_NAME.test(next.model))) state.settings.model = next.model;
    if (next.permission === 'review' || next.permission === 'automatic') state.settings.permission = next.permission;
    changed();
  });
  on('pairing:new', () => bridge.newPairingCode());
  on('pairing:clear', () => bridge.unpair());
  on('plugin:install', () => installPlugin({ source: fs.readFileSync(PLUGIN_FILE, 'utf8'), endpoint: ENDPOINT, dir: pluginsDir() }));
  on('agent:run', async (prompt) => {
    const request = typeof prompt === 'string' ? prompt.trim() : '';
    if (!request || request.length > 2000) throw new Error('Write a request of up to 2000 characters');
    if (!state.settings.model) throw new Error('Choose a model on the Models page first');
    if (!(await ollama.status()).running) throw new Error('Ollama is not running on this computer');
    const result = await runAgent({ ollama, model: state.settings.model, state, prompt: request });
    return bridge.addRun({ ...result, permission: state.settings.permission });
  });
  on('run:approve', (id) => bridge.approve(id));
  on('run:cancel', (id) => bridge.cancel(id));
}

function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#090a0f',
    show: !SMOKE,
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  return win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

async function smoke() {
  const lines = [];
  const check = (name, ok) => lines.push((ok ? 'ok   ' : 'FAIL ') + name);
  check('local link is listening' + (bridgeError ? ' (' + bridgeError + ')' : ''), !bridgeError);
  const res = await fetch(ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'poll', token: 'none' }) });
  check('local link refuses an unknown plugin', res.status === 401);
  check('plugin is bundled with the app', fs.readFileSync(PLUGIN_FILE, 'utf8').includes('"__ENDPOINT__"'));
  const version = await win.webContents.executeJavaScript('window.forge.state().then(function (s) { return s.version; })');
  check('window reached the app (version ' + version + ')', version === app.getVersion());
  let ready = false;
  for (let i = 0; i < 40 && !ready; i += 1) {
    ready = await win.webContents.executeJavaScript('document.body.dataset.ready === "true"');
    if (!ready) await new Promise((resolve) => setTimeout(resolve, 500));
  }
  check('interface rendered', ready === true);
  return lines;
}

async function start() {
  state = store.load(stateFile());
  bridge = createBridge({ state, onChange: changed });
  try {
    await bridge.listen(PORT);
  } catch (error) {
    bridgeError = error.code === 'EADDRINUSE'
      ? 'Port ' + PORT + ' is already used by another program on this computer, so Roblox Studio cannot connect.'
      : 'The link to Roblox Studio could not start: ' + error.message;
  }
  registerIpc();
  await createWindow();
  if (!SMOKE) return;
  let lines;
  try { lines = await smoke(); } catch (error) { lines = ['FAIL smoke check crashed: ' + error.message]; }
  if (process.env.FORGE_SMOKE_OUT) fs.writeFileSync(process.env.FORGE_SMOKE_OUT, lines.join('\n') + '\n');
  app.exit(lines.some((line) => line.startsWith('FAIL')) ? 1 : 0);
}

if (!SMOKE && !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
  app.on('before-quit', () => {
    clearTimeout(saveTimer);
    if (state && !SMOKE) store.save(stateFile(), state);
  });
  app.on('window-all-closed', () => app.quit());
  app.whenReady().then(start);
}
