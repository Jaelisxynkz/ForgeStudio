# ForgeStudio

AI-assisted building tools for Roblox creators. This repository holds the parts of ForgeStudio that run on your own machine.

## Contents

| Path | What it is | Status |
| --- | --- | --- |
| `plugin/` | Roblox Studio plugin that pairs a place with a ForgeStudio project, applies approved operations and reads each change back | Working against the cloud job queue, checked on every change |
| `desktop/` | Desktop app for local models | Not built yet |

## Plugin

`plugin/ForgeStudio.plugin.luau` is the source. The copy you install is downloaded from your ForgeStudio project, which fills in the `__ENDPOINT__` placeholder with the address of your workspace.

Every push that touches `plugin/` is compiled with the official Luau compiler and analyzed against the Roblox API (see `.github/workflows/plugin-check.yml`).

ForgeStudio is an independent project and is not affiliated with Roblox Corporation.
