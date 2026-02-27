# Nook

> Permanent decentralized storage for files, folders, and websites — a desktop app for the [Swarm](https://ethswarm.org) network.

Nook bundles a [Bee](https://github.com/ethersphere/bee) node and a clean consumer UI into a single menu-bar app. Drop files in, get a permanent link back. No accounts, no servers, no expiry — just Swarm.

![macOS | Linux | Windows](https://img.shields.io/badge/runs%20on-macOS%20%7C%20Linux%20%7C%20Windows-orange)
[![License: BSD-3-Clause](https://img.shields.io/badge/license-BSD--3--Clause-blue.svg)](./LICENSE)

## What you can do

- **Publish** — upload a file, folder, or static website and get a permanent Swarm hash
- **Drive** — browse your upload history, extend storage, and update feeds
- **Feeds** — create a permanent address that you can push new versions to (like a mutable link)
- **Wallet** — check your xDAI and BZZ balance, swap tokens, manage postage stamps
- **Settings** — configure your Bee API key and public gateway URL

## How it works

Nook manages a Bee node automatically in the background. When you start Nook:

1. The Electron app downloads and starts a Bee binary on `localhost:1633`
2. The UI connects to Bee directly for all storage operations
3. Files are stored on Swarm — retrievable via any public gateway or your local node

> **Note:** Nook always starts its own Bee node. If you already run a Bee node on port 1633, stop it before launching Nook.

## Install

Download the latest build from the [releases page](https://github.com/GasperX93/nook/releases/latest):

| Platform | File |
|---|---|
| macOS (Apple Silicon) | `Nook-darwin-arm64-*.zip` |
| macOS (Intel) | `Nook-darwin-x64-*.zip` |
| Linux | `nook_*_amd64.deb` or `nook-*-1.x86_64.rpm` |

**macOS note:** After unzipping, right-click the `.app` → Open to bypass the Gatekeeper warning on first launch.

## Development

```bash
npm install
cd ui && npm install && cd ..
npm start          # starts Electron backend + Vite dev server concurrently
```

The Electron backend is in `src/`. The React UI lives in `ui/` (Vite + React + Tailwind + Tanstack Query + Zustand).

```bash
npm run build      # production build (tsc + vite + copies ui into dist/)
npm run lint       # eslint fix
npm run test:unit  # jest unit tests
npm run purge:data # wipe app data folder (useful during dev)
npm run purge:logs # wipe log folder
```

### Data and log paths

| Platform | Data | Logs |
|---|---|---|
| macOS | `~/Library/Application Support/Nook` | `~/Library/Logs/Nook/` |
| Linux | `~/.local/share/Nook` | `~/.local/state/Nook/` |
| Windows | `%LOCALAPPDATA%\Nook\Data` | `%LOCALAPPDATA%\Nook\Log` |

## License

[BSD-3-Clause](./LICENSE)

Based on [swarm-desktop](https://github.com/ethersphere/swarm-desktop) by [Swarm Association](https://ethswarm.org).
