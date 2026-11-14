'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const LOCAL_ENDPOINT = /^http:\/\/127\.0\.0\.1:\d{2,5}\/pluginBridge$/;
const FILE_NAME = 'ForgeStudio.lua';

// Where Roblox Studio loads local plugins from. Null on systems Studio does not run on.
function pluginsDir(platform = process.platform, env = process.env, home = os.homedir()) {
  if (platform === 'win32') return env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, 'Roblox', 'Plugins') : null;
  if (platform === 'darwin') return path.join(home, 'Documents', 'Roblox', 'Plugins');
  return null;
}

function buildPlugin(source, endpoint) {
  if (!LOCAL_ENDPOINT.test(endpoint)) throw new Error('The plugin can only be pointed at this computer');
  if (!source.includes('"__ENDPOINT__"')) throw new Error('The plugin source is missing its address placeholder');
  return source.replace('__ENDPOINT__', endpoint);
}

function installPlugin({ source, endpoint, dir }) {
  if (!dir) throw new Error('Roblox Studio plugins are only supported on Windows and macOS');
  const file = path.join(dir, FILE_NAME);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, buildPlugin(source, endpoint));
  return file;
}

module.exports = { pluginsDir, buildPlugin, installPlugin, FILE_NAME };
