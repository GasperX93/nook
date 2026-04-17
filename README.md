# Nook

> A desktop drive on top of Swarm decentralised storage.

Nook bundles a [Bee](https://github.com/ethersphere/bee) node and a clean UI into a single desktop app. Store files, encrypt and share them, publish websites — all on decentralized storage. No accounts, no servers.

![macOS | Linux | Windows](https://img.shields.io/badge/runs%20on-macOS%20%7C%20Linux%20%7C%20Windows-orange)
[![License: BSD-3-Clause](https://img.shields.io/badge/license-BSD--3--Clause-blue.svg)](./LICENSE)

## What you can do

- **Store files** — upload any file or folder to Swarm, organized into drives with folders
- **Encrypt files** — create encrypted drives using Swarm's ACT (chunk-level encryption). Only people you grant access to can decrypt and download
- **Share encrypted drives** — grant access to specific users via their sharing key, generate a share link, and recipients get a live-syncing view of your files
- **Publish websites** — upload a website (HTML/CSS/JS) to Swarm and get a permanent link. Optionally attach a feed for updates so the URL stays the same when you publish new versions
- **Connect to ENS** — link your Swarm-hosted website to an ENS domain (e.g. `yourname.eth`) so anyone can access it via a gateway or ENS-aware browser
- **Manage your wallet** — view xDAI/xBZZ balances, swap between tokens, redeem gift codes, top up from any chain via the multichain widget
- **Extend storage** — drives have a TTL (time to live). Extend them to keep your data alive longer

## How it works

Nook manages a Bee node automatically. When you start Nook:

1. The app downloads and starts a Bee binary on `localhost:1633`
2. New installs start in ultra-light mode — no funds needed, the UI works immediately
3. When you fund your wallet with xDAI, Nook auto-switches to light mode and you can start uploading
4. Files are stored on Swarm — retrievable via any public gateway or your local node

> **Note:** Nook always starts its own Bee node. If you already run a Bee node on port 1633, stop it before launching Nook.

## Install

Download the latest build from the [releases page](https://github.com/GasperX93/nook/releases/latest):

| Platform | File |
|---|---|
| macOS (Apple Silicon) | `Nook-*-arm64.dmg` |
| macOS (Intel) | `Nook-*-x64.dmg` |
| Linux | `nook_*_amd64.deb` / `nook-*.x86_64.rpm` |
| Windows | `Nook-*-Setup.exe` |

**macOS note:** Right-click the `.app` → Open to bypass the Gatekeeper warning on first launch (app is not yet notarized).

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
