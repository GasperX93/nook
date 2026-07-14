# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Nook is an Electron-based desktop application that manages a Bee node on the Swarm decentralized storage network. It downloads and runs the Bee binary, exposes a Koa REST API, and serves a custom React dashboard (`ui/`).

## Verify Before You Assert or Change

Do not reason from assumptions, memory, or diff text alone. Every claim about how code behaves must be checked against the actual source before you act on it.

**Before changing code:**
- Read the function/module you are modifying AND its call sites — not just the lines in the diff. Understand what actually happens, not what the names suggest.
- If the change depends on the behavior of a dependency (Bee API, a library, another repo), open that source or its docs and confirm. Never assume an API's shape, defaults, or error behavior from its name.
- If you cannot access the source of truth, say so explicitly and mark the assumption — do not silently build on it.

**Before flagging or "fixing" something as wrong/stale:**
- Read the full surrounding context (whole section/function, adjacent code, related config), not just the line that looks wrong. The answer is often right next to it.
- Try to refute your own finding first: "what would make this correct as-is?" Only proceed if it survives.
- Distinguish confirmed facts from suspicions. Unverified concerns are phrased as questions ("is X intended?"), never as assertions ("X is broken").

**General rule:** a smaller number of verified changes/findings beats broad plausible ones. If verification would take one file read or one command, that read is mandatory — plausible-but-wrong costs far more than the check.

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
| `log-rotator.ts` | Rotation-safe bee log writer (`bee.0.log` active, shift-on-rotate, buffered during rotation) |
| `lifecycle.ts` | `BeeManager`: start/stop/restart Bee; keep-alive loop |
| `funding-monitor.ts` | Detects ultra-light/light mode, polls wallet balance via RPC, auto-switches to light mode when funded |
| `chequebook-monitor.ts` | Auto-funds the chequebook for bandwidth (deposits when balance drops below threshold) |
| `identity-cache.ts` | Server-side cache for the wallet-derived identity (survives page reloads) |
| `browser.ts` / `nook-deep-link.ts` | Opens the dashboard in the default browser; `nook://` protocol deep links (contact links) |
| `status.ts` | `/status` endpoint — exposes `mode` (ultra-light/light), `assetsReady` |
| `config.ts` | Reads/writes Bee YAML config |
| `downloader.ts` | Downloads the correct Bee binary version |
| `blockchain.ts` | Wallet management, BZZ/DAI transactions |
| `api-key.ts` | Generates/validates the API key injected into the dashboard URL |
| `migration.ts` | Versioned data migrations on startup |
| `path.ts` | Platform-specific data/log paths |
| `port.ts` | Finds a free local port |

**Startup sequence** (`index.ts`): migrations → splash → download Bee if needed → API key → free port → start Koa server → init Bee config → launch Bee → start funding monitor → start chequebook monitor → setup tray → keep-alive loop.

**Bundled Bee version**: `EXPECTED_BEE_VERSION` in `src/downloader.ts` (currently **2.8.1**). On launch the downloader compares the installed binary's version and force-redownloads on mismatch — existing installs auto-upgrade.

**Ultra-light / light mode**: New installs start in ultra-light mode (`swap-enable: false`, no `blockchain-rpc-endpoint`). Bee API is available immediately without funds. The funding monitor polls wallet balance every 15s. When xDAI is detected: stop Bee → write `blockchain-rpc-endpoint` and `swap-enable: true` → restart in light mode. Postage sync takes ~2–3 minutes thanks to clean snapshot loading.

**Server** (`server.ts`): Koa REST API. Serves the dashboard at `/dashboard` (unpacked from asar) and proxies `/bee-api/*` → `http://127.0.0.1:1633/*` (mirrors the Vite dev proxy so renderer code works in dev and prod). Routes: `/info`, `/status`, `/config`, `/logs/*`, `/restart`, `/swap`, `/redeem`, `/buy-stamp`, `/feed-update`, `/feed-read`, `/withdraw`, `/chequebook-withdraw`, `/peers`, `/grantee` (+ `GET|PATCH /grantee/:ref`), `/act/upload-metadata`, `/act/download/:hash`, `/upload-bytes` (direct/non-deferred — see #86), `/identity-cache`.

### Frontend (`ui/`) — Custom React app

Built with Vite + React 19 + Tailwind (shadcn primitives) + TanStack Query + Zustand. Pages (`ui/src/pages/`): Overview, Drive, AccessOnSwarm, Contacts, Account, Wallet, Identity, Settings, Logs, Dev. Apps (`ui/src/apps/`): Messages, WebsitePublisher. It's built separately, copied into `dist/ui/`, and served by the Koa server. The API key is injected via URL parameter.

Key files:
- `ui/src/api/bee.ts` — direct Bee node API calls (port 1633). Includes ACT upload/download functions. **Note:** the `immutable` flag for stamp creation is sent as an HTTP **header**, not a query param (e.g. `headers: { immutable: 'false' }`). Default stamp type is **immutable** throughout the UI.
- `ui/src/api/server.ts` — calls to the Nook Koa backend (ACT metadata, grantees, feeds, stamps)
- `ui/src/api/feeds.ts` — metadata feed operations for encrypted drives (DriveMetadata type, topic calculation, read/write)
- `ui/src/crypto/signer.ts` — wallet key derivation: NookSigner interface, HMAC-SHA256 sub-keys from wallet signature
- `ui/src/store/identity.ts` — Zustand store for wallet-derived signer; the raw signature is persisted to **sessionStorage** under `nook.derivedKey.v1`, cleared on wallet disconnect, address switch, or window close. Never written to localStorage or disk.
- `ui/src/hooks/useDriveMetadata.ts` — per-drive ACT metadata in localStorage (encrypted flag, history refs, grantee refs)
- `ui/src/hooks/useSharedDrives.ts` — shared drives localStorage store, share link parsing (feed-based and legacy snapshot)
- `ui/src/hooks/useDerivedKey.ts` — wallet → signer derivation hook with deterministic check
- `ui/src/components/ShareModal.tsx` — grantee management (grant/revoke), share link generation, contact autocomplete
- `ui/src/components/AddSharedDriveModal.tsx` — import shared drives from share links, feed-based and snapshot
- `ui/src/apps/WebsitePublisher.tsx` — publish wizard (select → options → publishing → done); "Permanent address" (feed) defaults ON; remembers a bought-but-unused stamp and reuses it on retry (never double-buys); sidebar click resets wizard via `location.key`
- `ui/src/pages/Drive.tsx` — drive list (rename via hover pencil or kebab; usage bar from `stampFillRatio`; Extend storage), upload history with recursive folder tree, encrypted drives + ACT uploads, "My Drives" / "Shared with me" tabs, feed-based shared-drive sync, re-publish after revoke
- `ui/src/lib/republish.ts` — re-encrypt & re-upload a drive's files under its current ACT key (post-revoke recovery)
- `ui/src/pages/Wallet.tsx` — balances (xDAI/xBZZ), collapsible multichain top-up widget, redeem gift code, swap
- `ui/src/pages/Account.tsx` — two tabs: Wallet + Identity (Nook address / identity publishing). Drive management lives on the Drive page.
- `ui/src/pages/Settings.tsx` — two-tab page: General (RPC URL, about) + Network (peer stats, developer mode toggle). Supports `?tab=network` query param.
- `ui/src/pages/Dev.tsx` — node config editor + live Bee logs + wallet key derivation test + "Exit Developer Mode" button (shown in dev mode only)
- `ui/src/components/Layout.tsx` — sidebar nav + Bee status banner; dot states: checking (gray), syncing/0 peers (orange), live (green), off (red); funding warning banner when mode is ultra-light
- `ui/src/hooks/useUploadHistory.ts` — localStorage records + folders with `parentFolderId` for subfolder support; includes `isEncrypted`, `actPublisher`, `actHistoryRef` fields
- `ui/src/index.css` — global styles + CSS overrides for `@upcoming/multichain-widget` internals (hiding the info banner, asterisks, adjusting min-height)
- `assets/splash.html` — startup splash screen (dark theme, iA Writer font, no external dependencies)

### Messaging (`ui/src/notify/` + `@swarm-notify/sdk`)

End-to-end encrypted messaging over Swarm feeds, using the **swarm-notify SDK** (pinned by commit in `ui/package.json` to `github:GasperX93/swarm-notify#<rev>`):

- **Append-only mailbox** (v2 feed topic): one message = one immutable feed index. The sender owns a persisted per-recipient **send cursor** (`notify/messages.ts`) so writes never depend on a network read-latest. ALL senders route through `notify/send-message.ts` → `sendMailboxMessage` (cursor + `mailbox.send`); per-recipient serialization via `notify/send-queue.ts`; node-readiness gate via `notify/bee-ready.ts`.
- **Payloads are direct-pushed** (`deferred: false` in the SDK and in Koa `/upload-bytes`) — "sent" means on-the-network; feed slots (SOC writes) are always direct in Bee.
- **First contact**: on-chain invitation ping via a notification registry on Gnosis (`registry.sendNotification`, paid by the connected wallet) — surfaces the invite before the recipient has added you back. The **Nook address** is the wallet-DERIVED address (never call it "ETH/wallet address" in UI).
- Contacts/threads/cursors are localStorage, **namespaced per derived identity** (`notify/active-identity.ts` `nsKey`).

### ACT encryption architecture

Encrypted drives use Bee's ACT (Access Control Trie) for chunk-level encryption. Three layers share one ACT history chain:

1. **Files** — uploaded with `swarm-act: true` header, each returns a new `Swarm-Act-History-Address`
2. **Grantees** — managed via `/grantee` endpoints, added to the SAME ACT chain (pass `historyRef`)
3. **Metadata feed** — Nook application layer. Feed topic: `keccak256(batchId + 'nook-drive-meta')`. Points to ACT-encrypted JSON metadata listing files. Wrapper (public) → metadata (ACT-encrypted).

ACT history chaining is critical: every operation returns a new history address that must be passed to the next operation. Breaking the chain means grantees lose access.

Share links: `swarm://feed?topic=<hex>&owner=<hex>&publisher=<hex>`. Non-grantees can read the feed but cannot decrypt the metadata (403).

ACT uses the **Bee node's public key** (from `/addresses`) as the sharing key, NOT wallet-derived keys. Wallet-derived keys are used for messaging identity (Nook address); ACT-on-wallet-keys is a future direction.

**Revoke rotates the ACT key** (Bee `pkg/accesscontrol`): content uploaded before a revoke stays encrypted under the OLD key, so a re-granted person can't open it until the drive is **re-published** (`ui/src/lib/republish.ts` re-encrypts files under the current key).

**Shared/encrypted content uploads are direct** (`swarm-deferred-upload: false`) — deferred uploads left chunks on the local light node and recipients got 404s. This applies to ACT file/collection uploads, metadata, and the feed wrapper.

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

## Branch workflow

- Feature/fix branches PR into **`develop`** (the default branch). develop is the testing ground — merge before testing, fix-forward there.
- **`master` is release-only** (branch-protected): release = PR develop → master (with version bump + CHANGELOG), `gh pr merge --admin`, tag `vX.Y.Z` on the merge commit. CI attaches Win/Linux assets on the tag; macOS DMG/ZIP are built and uploaded manually.
- Update `CHANGELOG.md` on every release.

## Electron & packaging

- Uses `electron-forge` with `forge.config.js` for packaging/publishing
- Targets: macOS (DMG + ZIP, with notarization), Windows (Squirrel EXE), Linux (DEB + RPM)
- Auto-updater is configured via electron's built-in mechanism
- TypeScript config (`tsconfig.json`): `"module": "commonjs"`, output to `dist/desktop/`
