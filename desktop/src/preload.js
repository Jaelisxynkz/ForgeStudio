'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const call = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld('forge', {
  state: call('state:get'),
  hardware: call('hardware:get'),
  ollamaInfo: call('ollama:info'),
  pull: call('ollama:pull'),
  removeModel: call('ollama:remove'),
  openOllama: call('ollama:download-page'),
  setSettings: call('settings:set'),
  newCode: call('pairing:new'),
  unpair: call('pairing:clear'),
  installPlugin: call('plugin:install'),
  runAgent: call('agent:run'),
  approve: call('run:approve'),
  cancel: call('run:cancel'),
  signIn: call('account:sign-in'),
  openApproval: call('account:open'),
  signOut: call('account:sign-out'),
  chooseProject: call('account:project'),
  onState: (listener) => { ipcRenderer.on('state', (event, value) => listener(value)); },
  onPull: (listener) => { ipcRenderer.on('pull', (event, value) => listener(value)); },
});
