# Changelog

## 0.2.0

- **One account for the website and the desktop app.** Sign in from the desktop app with a one-time code approved on the website. Projects, conversations and runs are then the same in both places.
- **Plan on your own computer from the website.** A project can be set to plan with a model on your computer: requests typed on the website are collected by your signed-in desktop app, answered by your local model and sent back for approval.
- **Approved runs reach Studio through the desktop app.** With the plugin paired to the desktop app, runs approved anywhere are applied through the local link and their read-back results appear on the website.
- **Nothing is applied twice.** Plans and Studio results are kept until ForgeStudio confirms them and re-sent after a lost connection; the server stores each one once.
- **Real model check.** Every change now downloads a real model through Ollama in the build pipeline and requires a real answer from it.
- The desktop app still works fully signed out, as in 0.1.0. Existing local runs and the Studio pairing are kept on upgrade.

Not yet verified: a run against a real Roblox Studio session. macOS builds are not included.

## 0.1.0

- First Windows pre-release: local models through Ollama and a local link to Roblox Studio.
