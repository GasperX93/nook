# Nook

> A desktop drive on top of Swarm decentralised storage.

Nook bundles a [Bee](https://github.com/ethersphere/bee) node and a clean UI into a single desktop app. Upload files, folders, and websites — get a permanent Swarm link back. No accounts, no servers.

![macOS | Linux | Windows](https://img.shields.io/badge/runs%20on-macOS%20%7C%20Linux%20%7C%20Windows-orange)
[![License: BSD-3-Clause](https://img.shields.io/badge/license-BSD--3--Clause-blue.svg)](./LICENSE)

## What you can do

- **Publish** — upload a file, folder, or static website and get a permanent Swarm hash
- **Drive** — browse your upload history in folders and subfolders, extend storage, update feeds
- **Feeds** — create a permanent address you can push new versions to (mutable link)
- **Wallet** — check xDAI and BZZ balance, swap tokens, top up from any chain via MetaMask
- **My Storage** — manage your drives, see TTL and usage, extend before they expire
- **Settings** — configure RPC endpoint, view network stats, toggle developer mode

## How it works

Nook manages a Bee node automatically. When you start Nook:

1. The app downloads and starts a Bee binary on `localhost:1633`
2. The UI connects to Bee for all storage operations
3. Files are stored on Swarm — retrievable via any public gateway or your local node

> **Note:** Nook always starts its own Bee node. If you already run a Bee node on port 1633, stop it before launching Nook.

## Install

Download the latest build from the [releases page](https://github.com/GasperX93/nook/releases/latest):

| Platform | File |
|---|---|
| macOS (Apple Silicon) | `Nook-darwin-arm64-*.dmg` |

**macOS note:** Right-click the `.app` → Open to bypass the Gatekeeper warning on first launch (app is not yet notarized).

Linux and Windows builds are planned for a future release.

## Development

```bash
npm install
cd ui && npm install && cd ..
npm start          # starts Electron backend + Vite dev server
```

The Electron backend is in `src/`. The React UI lives in `ui/` (Vite + React 19 + Tailwind + TanStack Query + Zustand).

```bash
npm run build      # production build (tsc + vite + copies ui into dist/)
npm run make       # create platform installer (DMG on macOS)
npm run lint       # eslint fix
npm run test:unit  # jest unit tests
npm run purge:data # wipe app data (useful during dev)
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
