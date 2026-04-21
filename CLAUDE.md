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
| `funding-monitor.ts` | Detects ultra-light/light mode, polls wallet balance via RPC, auto-switches to light mode when funded |
| `status.ts` | `/status` endpoint — exposes `mode` (ultra-light/light), `assetsReady` |
| `config.ts` | Reads/writes Bee YAML config |
| `downloader.ts` | Downloads the correct Bee binary version |
| `blockchain.ts` | Wallet management, BZZ/DAI transactions |
| `api-key.ts` | Generates/validates the API key injected into the dashboard URL |
| `migration.ts` | Versioned data migrations on startup |
| `path.ts` | Platform-specific data/log paths |
| `port.ts` | Finds a free local port |
| `deep-link.ts` | Handles `swarm://` protocol URLs; queues pre-ready URLs, opens dashboard with share param |

**Startup sequence** (`index.ts`): register protocol handlers → migrations → splash → download Bee if needed → API key → free port → start Koa server → check argv for deep link → init Bee config → launch Bee → start funding monitor → setup tray → flush pending deep link → keep-alive loop.

**Ultra-light / light mode**: New installs start in ultra-light mode (`swap-enable: false`, no `blockchain-rpc-endpoint`). Bee API is available immediately without funds. The funding monitor polls wallet balance every 15s. When xDAI is detected: stop Bee → write `blockchain-rpc-endpoint` and `swap-enable: true` → restart in light mode. Postage sync takes ~2–3 minutes thanks to clean snapshot loading.

**Server** (`server.ts`): Koa REST API. Public routes: `/info`, `/price`. Auth-required routes (API key header): `/status`, `/config`, `/logs/*`, `/restart`, `/swap`, `/redeem`, `/buy-stamp`, `/feed-update`, `/feed-read`, `/withdraw`, `/peers`, `/act/*`, `/grantee`, `/upload-bytes`.

**Deep linking** (`swarm://` protocol): Clicking a `swarm://` URL anywhere on the system opens the Nook dashboard with the shared drive import flow pre-triggered. Flow: OS delivers URL to Electron main process → `deep-link.ts` queues or handles → opens `http://localhost:PORT/dashboard/?v=API_KEY&share=<encoded-url>` → React reads `share` param → navigates to Drive page → auto-opens AddSharedDriveModal with link pre-filled. Platform specifics: macOS uses `open-url` event + `protocols` in forge packagerConfig; Windows uses `second-instance` argv + runtime registry via `setAsDefaultProtocolClient`; Linux uses `second-instance` argv + `mimeType` in DEB/RPM makers. Note: deep linking only works when the app is packaged (macOS/Linux). Windows works in dev mode.

### Frontend (`ui/`) — Custom React app

Built with Vite + React 19 + Tailwind + TanStack Query + Zustand. Pages: Publish, Drive, Account, Settings, Logs, Dev. It's built separately, copied into `dist/ui/`, and served by the Koa server. The API key is injected via URL parameter.

Key files:
- `ui/src/api/bee.ts` — direct Bee node API calls (port 1633). Includes ACT upload/download functions. **Note:** the `immutable` flag for stamp creation is sent as an HTTP **header**, not a query param (e.g. `headers: { immutable: 'false' }`). Default stamp type is **immutable** throughout the UI.
- `ui/src/api/server.ts` — calls to the Nook Koa backend (ACT metadata, grantees, feeds, stamps)
- `ui/src/api/feeds.ts` — metadata feed operations for encrypted drives (DriveMetadata type, topic calculation, read/write)
- `ui/src/crypto/signer.ts` — wallet key derivation: NookSigner interface, HMAC-SHA256 sub-keys from wallet signature
- `ui/src/store/identity.ts` — Zustand store for wallet-derived signer (in-memory only, never persisted)
- `ui/src/hooks/useDriveMetadata.ts` — per-drive ACT metadata in localStorage (encrypted flag, history refs, grantee refs)
- `ui/src/hooks/useSharedDrives.ts` — shared drives localStorage store, share link parsing (feed-based and legacy snapshot)
- `ui/src/hooks/useDerivedKey.ts` — wallet → signer derivation hook with deterministic check
- `ui/src/components/ShareModal.tsx` — grantee management (grant/revoke), share link generation, contact autocomplete
- `ui/src/components/AddSharedDriveModal.tsx` — import shared drives from share links, feed-based and snapshot
- `ui/src/pages/Publish.tsx` — multi-step publish wizard (select → storage → feed → done); sidebar click resets wizard via `location.key`
- `ui/src/pages/Drive.tsx` — upload history with recursive folder tree (any depth), encrypted drives, ACT uploads, "My Drives" / "Shared with me" tabs, feed-based sync
- `ui/src/pages/Wallet.tsx` — balances (xDAI/xBZZ), collapsible multichain top-up widget, redeem gift code, swap, sharing key display
- `ui/src/pages/Account.tsx` — two-tab page: Wallet (navigates to Wallet page) + My Storage (drive list with TTL bars, extend drive, buy new drive)
- `ui/src/pages/Settings.tsx` — two-tab page: General (RPC URL, about) + Network (peer stats, developer mode toggle). Supports `?tab=network` query param.
- `ui/src/pages/Dev.tsx` — node config editor + live Bee logs + wallet key derivation test + "Exit Developer Mode" button (shown in dev mode only)
- `ui/src/components/Layout.tsx` — sidebar nav + Bee status banner; dot states: checking (gray), syncing/0 peers (orange), live (green), off (red); funding warning banner when mode is ultra-light
- `ui/src/hooks/useUploadHistory.ts` — localStorage records + folders with `parentFolderId` for subfolder support; includes `isEncrypted`, `actPublisher`, `actHistoryRef` fields
- `ui/src/index.css` — global styles + CSS overrides for `@upcoming/multichain-widget` internals (hiding the info banner, asterisks, adjusting min-height)
- `assets/splash.html` — startup splash screen (dark theme, iA Writer font, no external dependencies)

### ACT encryption architecture

Encrypted drives use Bee's ACT (Access Control Trie) for chunk-level encryption. Three layers share one ACT history chain:

1. **Files** — uploaded with `swarm-act: true` header, each returns a new `Swarm-Act-History-Address`
2. **Grantees** — managed via `/grantee` endpoints, added to the SAME ACT chain (pass `historyRef`)
3. **Metadata feed** — Nook application layer. Feed topic: `keccak256(batchId + 'nook-drive-meta')`. Points to ACT-encrypted JSON metadata listing files. Wrapper (public) → metadata (ACT-encrypted).

ACT history chaining is critical: every operation returns a new history address that must be passed to the next operation. Breaking the chain means grantees lose access.

Share links: `swarm://feed?topic=<hex>&owner=<hex>&publisher=<hex>`. Non-grantees can read the feed but cannot decrypt the metadata (403).

ACT uses the **Bee node's public key** (from `/addresses`) as the sharing key, NOT wallet-derived keys. Wallet-derived keys are reserved for future features (cross-device ACT, Swarm Mail, identity feeds).

## UI terminology

Swarm concepts are abstracted in the UI to avoid exposing technical internals:

| Swarm concept | UI term |
|---------------|---------|
| Postage stamp | Drive |
| Top up stamp | Extend drive |
| Stamp TTL | Expires in |

Never use "stamp", "postage", or "top up" in user-facing strings.

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
