# ForgeStudio

AI-assisted building tools for Roblox creators. This repository holds the parts of ForgeStudio that run on your own computer.

| Path | What it is |
| --- | --- |
| `desktop/` | Windows desktop app. Runs free open-source models on your computer through Ollama, turns a request into a plan and reviewable operations, and sends approved runs to Roblox Studio over a link that never leaves your machine. |
| `plugin/` | Roblox Studio plugin. Pairs a place with ForgeStudio, applies approved operations as one undo step and reads each change back. The same file serves the desktop app and the web workspace. |

## Desktop app

Download the installer from the Releases page. It is not code-signed yet, so Windows shows a SmartScreen warning the first time.

1. Install [Ollama](https://ollama.com/download), then pick a model on the Models page. The app suggests one for the memory in your computer.
2. On the Roblox Studio page, install the plugin and restart Studio.
3. Show a pairing code and type it into the ForgeStudio panel in Studio.
4. Describe what to build. Nothing changes in your place until you approve the run, unless you switch to automatic mode. Removals always wait for approval.

The link to Studio listens on `127.0.0.1:47771` only. It refuses requests from web pages, needs a one-time pairing code, and stores only a hash of the plugin token.

### Develop

```
cd desktop
npm install
npm start      # run the app
npm test       # run the tests (no install needed)
npm run dist   # build the Windows installer
```

## Checks

- `Plugin check` compiles the plugin with the official Luau compiler and analyzes it against the Roblox API.
- `Desktop app` runs the tests on Linux and Windows, builds the installer, then starts the built app and checks that its window, its link to Studio and the bundled plugin are alive.

Neither check runs Roblox Studio. The plugin applying changes inside a real place is tested by hand.

ForgeStudio is an independent project and is not affiliated with Roblox Corporation.
