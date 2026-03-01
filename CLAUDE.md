# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Nook is an Electron-based desktop application that manages a Bee node on the Swarm decentralized storage network. It downloads and runs the Bee binary, exposes a Koa REST API, and serves a custom React dashboard (`ui/`).

## Commands

```bash
# Development
npm start              # Run Electron app + UI concurrently (dev mode)

# Build
npm run build          # Full build: tsc + build UI + copy UI assets
npm run build:desktop  # TypeScript compilation only (tsc)
npm run build:ui       # Build Bee Dashboard (ui/)
npm run copy:ui        # Copy UI dist into output

# Code quality
npm run lint           # ESLint fix + UI lint
npm run lint:check     # ESLint check only (no fix)
npm run check:types    # TypeScript type check

# Tests
npm run test:unit      # Run Jest unit tests (verbose)
cd ui && npm test      # Run Vitest tests for UI utility functions

# Packaging
npm run package        # Package Electron app (no installer)
npm run make           # Create platform installers (DMG, EXE, DEB, RPM, ZIP)
npm run publish        # Publish to GitHub releases

# Cleanup
npm run clean          # Remove dist/ and out/
npm run purge:data     # Clear app data folder
npm run purge:logs     # Clear app logs folder
```

## Architecture

The app has two main layers:

### Backend (`src/`) — Electron main process (TypeScript → CommonJS)

| File | Role |
|------|------|
| `index.ts` | Entry point: orchestrates startup sequence |
| `electron.ts` | Electron app lifecycle, tray icon, window management |
| `server.ts` | Koa HTTP server — REST API + serves React dashboard at `/dashboard` |
| `launcher.ts` | Spawns the Bee binary as a child process, streams logs |
| `lifecycle.ts` | `BeeManager`: start/stop/restart Bee; keep-alive loop |
| `config.ts` | Reads/writes Bee YAML config |
| `downloader.ts` | Downloads the correct Bee binary version |
| `blockchain.ts` | Wallet management, BZZ/DAI transactions |
| `api-key.ts` | Generates/validates the API key injected into the dashboard URL |
| `migration.ts` | Versioned data migrations on startup |
| `path.ts` | Platform-specific data/log paths |
| `port.ts` | Finds a free local port |

**Startup sequence** (`index.ts`): migrations → splash → download Bee if needed → API key → free port → start Koa server → init Bee config → launch Bee → setup tray → keep-alive loop.

**Server** (`server.ts`): Koa REST API. Public routes: `/info`, `/price`. Auth-required routes (API key header): `/status`, `/config`, `/logs/*`, `/restart`, `/swap`, `/redeem`, `/buy-stamp`, `/feed-update`.

### Frontend (`ui/`) — Custom React app

Built with Vite + React 19 + Tailwind + TanStack Query + Zustand. Pages: Publish, Drive, Account, Settings, Logs, Dev. It's built separately, copied into `dist/ui/`, and served by the Koa server. The API key is injected via URL parameter.

Key files:
- `ui/src/api/bee.ts` — direct Bee node API calls (port 1633). **Note:** the `immutable` flag for stamp creation is sent as an HTTP **header**, not a query param (e.g. `headers: { immutable: 'false' }`).
- `ui/src/api/server.ts` — calls to the Nook Koa backend
- `ui/src/pages/Publish.tsx` — multi-step publish wizard (select → storage → feed → done)
- `ui/src/pages/Drive.tsx` — upload history, feed updates, stamp top-up
- `ui/src/pages/Account.tsx` — two-tab page: Wallet (balances, swap, redeem, multichain top-up widget) + My Storage (stamp list with TTL bars, top-up, buy new stamp)
- `ui/src/pages/Dev.tsx` — node config editor + live Bee logs (shown in dev mode only)
- `ui/src/components/Layout.tsx` — sidebar nav + Bee status banner
- `ui/src/index.css` — global styles + CSS overrides for `@upcoming/multichain-widget` internals (hiding the info banner, asterisks, adjusting min-height)

## Key data paths (runtime)

- **macOS logs**: `~/Library/Logs/Nook/`
- **macOS data**: `~/Library/Application Support/Nook/`
- **Windows logs**: `%LOCALAPPDATA%\Nook\Log\`
- **Windows data**: `%LOCALAPPDATA%\Nook\Data\`
- **Linux logs**: `~/.local/state/Nook/`
- **Linux data**: `~/.local/share/Nook/`

## Build output

- `dist/desktop/` — compiled TypeScript (main process)
- `dist/ui/` — built React dashboard
- `out/` — packaged Electron app (after `npm run package`/`make`)

## Electron & packaging

- Uses `electron-forge` with `forge.config.js` for packaging/publishing
- Targets: macOS (DMG + ZIP, with notarization), Windows (Squirrel EXE), Linux (DEB + RPM)
- Auto-updater is configured via electron's built-in mechanism
- TypeScript config (`tsconfig.json`): `"module": "commonjs"`, output to `dist/desktop/`
