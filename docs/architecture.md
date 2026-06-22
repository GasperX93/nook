# Architecture

This doc covers how Nook is wired together at the process and HTTP level — the Electron main process, the embedded Koa server, the Bee subprocess, and the renderer. It's the map you read first before diving into any topic doc.

> One-line summary: Electron spawns Bee as a subprocess and runs an in-process Koa server on a fixed local port. The renderer is a React app served by Koa and talks to two HTTP layers: Koa (auth-required, header-injection proxy for Bee) and Bee directly (chunk uploads/downloads). The whole stack runs on the user's machine — no remote server.

---

## Process model

```
┌──────────────────────────────────────────────────────────────┐
│ Electron app                                                 │
│                                                              │
│  ┌─────────────────────────────────┐                         │
│  │ Main process (src/)             │                         │
│  │   - Koa server (port 3054)      │                         │
│  │   - BeeManager (lifecycle)      │                         │
│  │   - Funding monitor             │                         │
│  │   - Auto-updater                │                         │
│  │   - Tray + splash               │                         │
│  └─────────────────────────────────┘                         │
│              │                                               │
│              │ spawn / SIGINT                                │
│              ▼                                               │
│  ┌─────────────────────────────────┐                         │
│  │ Bee subprocess (Go binary)      │                         │
│  │   - HTTP API on 127.0.0.1:1633  │                         │
│  │   - P2P over libp2p             │                         │
│  └─────────────────────────────────┘                         │
│                                                              │
│  ┌─────────────────────────────────┐                         │
│  │ Renderer (BrowserWindow OR      │                         │
│  │ system browser)                 │                         │
│  │ Loaded from Koa:                │                         │
│  │   http://localhost:3054/dashboard│                        │
│  │   /?v=<api-key>                 │                         │
│  └─────────────────────────────────┘                         │
└──────────────────────────────────────────────────────────────┘
```

Two TypeScript projects:

| Project | Compiled output | Loads |
|---|---|---|
| `src/` (main) | `dist/desktop/` — CommonJS | Electron Node.js |
| `ui/` (renderer) | `dist/ui/` — ES modules + bundled assets | Browser, served by Koa at `/dashboard` |

The renderer never opens directly on `file://` — it always comes via Koa so that:
1. URLs are stable (`localhost:3054/dashboard/...`)
2. The Koa `/bee-api/*` pass-through proxy is the same origin (no CORS)
3. The API key flows in via URL parameter

---

## Transports

The renderer talks to **two HTTP endpoints**, each with a distinct role:

| Endpoint | Origin in renderer | Auth | When used |
|---|---|---|---|
| **Bee direct** | `${origin}/bee-api/*` → Koa pass-through → `http://127.0.0.1:1633/*` | None (Bee runs unrestricted) | High-throughput / streaming ops: file upload/download, feed read/write, ACT download, stamp list, peers, addresses |
| **Koa Nook API** | `${origin}/<route>` | `Authorization: <api-key>` (except `/info`) | Auth-gated ops + header-injection proxy: `/buy-stamp`, `/grantee`, `/act/upload-metadata`, `/act/download`, `/feed-update`, `/restart`, etc. |

Same origin (`localhost:3054`) for both → no CORS dance. In dev, Vite's `/bee-api` proxy mirrors the Koa pass-through so identical renderer code runs unmodified.

### Why Koa proxies Bee for some routes

Three reasons specific routes go through Koa instead of hitting Bee directly:

1. **Browser strips custom headers on localhost cross-origin requests.** `swarm-act-*` headers, `immutable: false`, etc. disappear before they reach Bee. Koa is same-origin and can re-inject them server-side.
2. **Bee 2.x sometimes requires `Authorization: Bearer <password>`.** Koa knows the password (it owns the config); the renderer never sees it.
3. **Centralize chain interactions.** `/redeem`, `/swap`, `/withdraw` need the wallet's keystore password to sign. Renderer doesn't have access. Koa does.

The `/bee-api` pass-through middleware (`src/server.ts:45`) handles everything that doesn't need any of the above — it's a thin transparent proxy.

---

## Koa server — route taxonomy

`src/server.ts`. Registered routes split into three categories by auth requirement:

### Open routes (no auth)

| Route | Purpose |
|---|---|
| `GET /info` | App name + version + auto-update support flag. Used by the renderer to decide what to show in Settings → About. |
| `/bee-api/*` (pass-through middleware) | Transparent proxy to `http://127.0.0.1:1633/*`. Mirrors the Vite dev proxy. |
| `/dashboard/*` (koa-static) | Serves the built UI from `dist/ui/`. |

### Auth-required routes

All routes below this middleware require `Authorization: <api-key>` matching the UUID stored at `<data-dir>/api-key.txt`. Mismatched/missing → 401.

**Status & config:**
- `GET /status` — bee mode, assetsReady, address, config snapshot, **userStopped** flag (see [BeeManager](#beemanager--lifecycle-state-machine))
- `GET /config` / `POST /config` — read/write Bee `config.yaml`
- `GET /peers` — peer connection count (used by the live/sync indicator)
- `GET /logs/nook` / `GET /logs/bee` — tail recent log files

**Identity cache** (Electron safeStorage wrappers — see [identity.md](identity.md)):
- `GET /identity-cache` → `{ available, value }`
- `POST /identity-cache` → encrypt and persist
- `DELETE /identity-cache` → clear

**Lifecycle:**
- `POST /restart` — stop Bee, wait for shutdown, relaunch. Wired to the "Bee is stopped" splash → Start button.

**Wallet operations** (use the Bee node's wallet keystore):
- `POST /redeem` — apply a gift code to the node wallet
- `POST /swap` — xDAI ↔ xBZZ swap
- `POST /withdraw` — withdraw native or BZZ to an external address
- `POST /chequebook-withdraw` — withdraw chequebook balance

**Stamps:**
- `POST /buy-stamp` — proxies to Bee with `immutable: <string>` header + Bearer auth. The only path that can create a mutable stamp because of the header-stripping issue.

**Feeds:**
- `POST /feed-update` — sign + upload a feed update using the Bee node's wallet (used for community-calls feed and similar)
- `GET /feed-read` — read a feed entry

**ACT (encrypted drives — see [encryption.md](encryption.md)):**
- `POST /act/upload-metadata` — upload ACT-encrypted JSON, return `{ reference, historyRef }`
- `GET /act/download/:hash` — download via ACT proxy with publisher + history headers
- `POST /grantee` — create grantee list
- `GET /grantee/:ref` — list grantees
- `PATCH /grantee/:ref` — add/revoke grantees

**Misc:**
- `POST /upload-bytes` — fire-and-forget upload helper used by some internal flows

### CORS

Allows `*` in development; locks to `http://localhost:${port}` in production. Both modes allow standard auth headers. Set in the CORS middleware at `src/server.ts:101`.

---

## Startup sequence

Implemented in `src/index.ts`. The order matters — each step's outputs feed the next.

```
0. Module load
   ├─ runMigrations()                  src/migration.ts
   ├─ registerNookProtocol()           OS-level nook:// handler
   └─ Wire up open-url / second-instance for deep links

1. app.whenReady() (implicit via Electron) → main()
   ├─ Log version + NODE_ENV
   ├─ initSplash()                     Splash screen window
   └─ updateElectronApp()              Auto-updater starts checking GitHub releases

2. Asset readiness
   ├─ Check Nook version (last seen vs PACKAGE_JSON.version)
   ├─ Check Bee binary version (installed vs EXPECTED_BEE_VERSION)
   └─ If either changed → runDownloader(force=true)
        - Downloads bee binary from GitHub release archive
        - Verifies checksum
        - Extracts to <data-dir>/bee
        - writeNookVersionFile() — stamps current version for next-launch check

3. Local services
   ├─ ensureApiKey()                   Generate/load <data-dir>/api-key.txt (UUID v4)
   ├─ findFreePort()                   Fail if 3054 is taken (no auto-fallback; clear error)
   └─ runServer()                      Start Koa on port 3054

4. Bee initialization
   ├─ If config.yaml missing → initializeBee() — bee init --config=<path>
   └─ runLauncher()                    Spawn Bee subprocess

5. Background monitors
   ├─ startMonitorIfNeeded()           Funding monitor (only in ultra-light mode)
   └─ startChequebookMonitor()         Watches for chequebook initialization in light mode

6. UI surface
   ├─ runElectronTray()                Tray icon + menu (Stop Bee, Open Web UI, Quit)
   └─ openDashboardInBrowser() (prod)  Pops the system browser at the dashboard URL

7. Wrap-up
   ├─ splash.hide()
   ├─ flushPendingNookUrl()            Replay any deep-link URL queued during startup
   └─ runKeepAliveLoop()               Start the BeeManager keep-alive poller
```

Error path: any uncaught exception in `main()` triggers `errorHandler`, which hides the splash and shows a system dialog. The app stays open so the user can read logs / quit gracefully.

---

## BeeManager — lifecycle state machine

`src/lifecycle.ts`. The source of truth for whether Bee should be running.

```ts
interface State {
  process: Promise<number | void> | null
  running: boolean
  shouldRun: boolean
  abortController: AbortController | null
  wasEverStarted: boolean
}
```

| Flag | Set true by | Set false by | Meaning |
|---|---|---|---|
| `shouldRun` | `runLauncher` → `setUserIntention(true)` | `BeeManager.stop()` from tray / `/restart` / funding-monitor switchover | User's *intent*: should we be running Bee? |
| `running` | `signalRunning` (right before `await subprocess`) | `signalStopped` (after subprocess resolves) | Actual process state. |
| `wasEverStarted` | First call to `signalRunning` | (never reset) | Distinguishes initial boot from a deliberate post-start stop. |

`isRunning()` is the read accessor — true if either `running` or the abort controller is still active (covers the brief window between `signalRunning` and the `running` flag flip).

### Keep-alive loop

`runKeepAliveLoop` in `src/launcher.ts`:

```ts
setInterval(() => {
  if (!BeeManager.isRunning() && BeeManager.shouldRestart()) {
    runLauncher()
  }
}, 10000)
```

Polls every 10s. Respawns Bee **only if `shouldRun = true`**. This is intentional — the user clicking "Stop Bee" in the tray sets `shouldRun = false` and Bee stays down. Without the `shouldRun` check, a deliberate stop would race the loop and immediately restart.

### `userStopped` for the UI

`/status` returns:
```ts
userStopped: BeeManager.wasEverStarted() && !BeeManager.shouldRestart()
```

i.e., true only if Bee has started at least once and the user has since stopped it. The `wasEverStarted` guard avoids false positives during the boot window before `runLauncher()` flips `shouldRun` to true.

The renderer reads this and shows a "Bee node is stopped" splash with a Start button (calling `/restart`) instead of the misleading "Starting your node…" spinner that would otherwise loop forever.

---

## Funding monitor — ultra-light vs light mode

`src/funding-monitor.ts`. Bee can run in two modes:

| Mode | Config flags | Capabilities | When used |
|---|---|---|---|
| **Ultra-light** | `swap-enable: false`, no `blockchain-rpc-endpoint` | Browse Swarm, read public data, no stamps, no uploads needing payment | First-launch state before user funds wallet |
| **Light** | `swap-enable: true`, `blockchain-rpc-endpoint: https://rpc.gnosischain.com` | All of above + stamp purchase, uploads, chequebook | Once wallet has any xDAI |

The monitor polls the wallet balance via RPC every 15s while in ultra-light mode. When at least `MIN_XDAI = 0.001` arrives:

```
1. stopMonitor() — stop the timer
2. BeeManager.stop() + waitForSigtermToFinish() — graceful Bee shutdown
3. writeConfigYaml({ 'blockchain-rpc-endpoint': RPC_ENDPOINT, 'swap-enable': true })
4. currentMode = 'light'
5. runLauncher() — restart Bee with new config
6. onLightModeSwitch() — schedule chequebook funding once Bee is ready
```

The mode switch takes ~2-3 minutes total: Bee shuts down, restarts, fetches the postage snapshot, becomes usable. The renderer shows a funding banner during this window; the dashboard remains operational.

### Why ultra-light to start?

Lets the dashboard come up immediately on first run — no waiting for a wallet to be funded before the user can see the UI. The funding banner explains what's blocked until xDAI arrives.

---

## Data paths

Platform paths are resolved via `env-paths` (`src/path.ts`):

| Platform | Data | Logs |
|---|---|---|
| macOS | `~/Library/Application Support/Nook/` | `~/Library/Logs/Nook/` |
| Linux | `~/.local/share/Nook/` | `~/.local/state/Nook/` |
| Windows | `%LOCALAPPDATA%\Nook\Data\` | `%LOCALAPPDATA%\Nook\Log\` |

Within `<dataDir>`:

```
<dataDir>/
├── api-key.txt              # UUID v4, regenerated on data purge
├── config.yaml              # Bee config (Nook-managed)
├── nook-version.txt         # last-launched Nook version (asset-version tracking)
├── identity-cache.bin       # safeStorage-encrypted derived key seed (see identity.md)
├── bee                      # Bee binary
└── data-dir/                # Bee's own data directory
    ├── keys/
    │   └── swarm.key        # Bee's V3 keystore (the "node wallet")
    ├── localstore/          # chunk storage
    └── statestore/          # peer state, postage snapshot, etc.
```

Within `<logDir>`:

```
<logDir>/
├── nook.log                 # Koa request log + main-process events
├── nook<N>.log              # rotated older Nook logs
├── bee.current.log -> bee.<latest>.log
└── bee.<N>.log              # one per Bee process spawn; rotated
```

The Nook keep-alive loop spawning a fresh Bee process triggers a new `bee.<N>.log` file. `bee.current.log` is a symlink to the most recent one — what to tail when debugging current behavior.

---

## API key

A UUID v4 generated on first launch and stored at `<dataDir>/api-key.txt`. The dashboard URL injects it as a query parameter:

```
http://localhost:3054/dashboard/?v=<api-key>
```

The renderer parses the `?v=` param at boot, stores it in `useAppStore.apiKey`, and includes it as the `Authorization` header on every Koa-bound request. The Koa auth middleware (`src/server.ts:124`) compares header → key file → 401 on mismatch.

### Why an API key for localhost

Defends against:
- Other apps on the same machine hitting `localhost:3054` and triggering wallet operations
- A malicious browser tab fetching `localhost:3054/swap` and trying to drain funds

The `Authorization` header is `simple-keyword: <api-key>` (not `Bearer`) because we never wanted the friction of OAuth-style negotiation for a key that's already authenticated by file access.

`/info` is the one open route — it has to be open so the dashboard can read the version before authenticating.

---

## Migrations

`src/migration.ts` runs at module load (before `main()`). It owns version-by-version config rewrites for users upgrading from an older Nook. Examples that have shipped:

- Migrate `xdai.fairdatasociety.org` → `https://rpc.gnosischain.com` (faster postage sync)
- Delete `use-postage-snapshot: true` from old configs (Bee 2.7.1 removed that flag)
- Set `skip-postage-snapshot: false` for users on older Nooks

The pattern: read the config, apply each migration idempotently, write back. Migrations are safe to re-run.

When changing default Bee config in `src/launcher.ts → createConfiguration`, write a corresponding migration so existing users get the update — the launcher only runs for *new* config files.

---

## Auto-updater

`updateElectronApp()` from `update-electron-app` runs early in `main()`. It checks GitHub releases for `Nook-${version}-${platform}` artifacts via Squirrel.

| Platform | Status |
|---|---|
| macOS arm64 | Supported (Squirrel.Mac) |
| Windows x64 | Supported (Squirrel.Windows) |
| Linux | Not supported (user must download manually) |

`/info` returns `autoUpdateEnabled: <platform supported>` so the Settings UI can show or hide the version row's "auto-updates active" badge.

---

## Logger

`src/logger.ts` wraps a file-stream-rotator-backed file logger plus a console transport in dev mode. Two log streams:

- `nook.log` — main process events + Koa request log (every Koa request emits an `api access` line with `method`, `uri`, `status`, `duration`, `user-agent`)
- `bee.current.log` — captured from Bee's stdout/stderr

The renderer can pull both via `/logs/nook` and `/logs/bee` (auth-required). Logs page renders them.

`subscribeLogServerRequests` exposes a hook for tests / debug that fires on every Koa request.

---

## Deep links (`nook://`)

`src/nook-deep-link.ts`. Nook registers itself as the OS handler for `nook://` URLs at module load. Used today for:

- `nook://contact/v1?addr=…&wpub=…&bpub=…` — add a contact (see [identity.md](identity.md))

On each platform:
- **macOS**: OS fires `open-url` event with the URL
- **Windows / Linux**: OS launches a second instance with the URL as `argv[1]`, caught via `second-instance`

If the URL arrives during startup, it's queued and replayed by `flushPendingNookUrl()` after the dashboard is ready.

---

## Build & packaging

```
npm run build:desktop      # tsc → dist/desktop/
npm run build:ui           # rimraf dist + tsc -b + vite build → ui/dist/
npm run copy:ui            # node devkit.mjs copy:ui → dist/ui/
npm run build              # all three above
npm run package            # electron-forge package → out/
npm run make               # electron-forge make → out/make/ (DMG, EXE, DEB, RPM, ZIP)
npm run publish:mac:arm64  # build artifacts (GitHub upload disabled by default — manual gh release upload)
```

`electron-forge` config lives in `forge.config.js`. Mac builds require a Developer ID for notarization (we don't notarize yet — issue #9).

In dev (`npm start`):
- `cd ui && npm start` runs Vite on port 3002 (HMR)
- The main process runs from `dist/desktop/` after a `clean && build`
- The renderer URL the Electron BrowserWindow loads varies — in production it's the Koa-served path; in dev some flows still open 3054 (Koa-served stale dist) instead of 3002

> See project memory: **always use 3002 when testing dev work** — 3054 serves a stale UI bundle until you rebuild. The two ports also have separate browser origins, so localStorage state (drives, contacts, threads) doesn't carry between them.

---

## Frontend organization

The renderer is one React 19 app — no SSR, no remote API outside of Koa+Bee.

```
ui/src/
├── App.tsx                # React Router routes
├── components/
│   ├── Layout.tsx          # Sidebar + header + outlet
│   ├── Onboarding.tsx      # Splash / starting / funding / syncing / ready flow
│   ├── ShareModal.tsx      # Encrypted-drive grantee management
│   └── ui/                 # Primitives (Button, Sidebar, etc.)
├── pages/                  # Top-level routed pages
│   ├── Drive.tsx
│   ├── Account.tsx
│   ├── Contacts.tsx
│   ├── Identity.tsx
│   ├── Settings.tsx
│   ├── AccessOnSwarm.tsx
│   └── Dev.tsx
├── apps/                   # Embedded features
│   ├── Messages.tsx        # Chat UI (also embedded inside Contacts)
│   └── WebsitePublisher.tsx
├── api/
│   ├── bee.ts              # Direct-to-Bee client (/bee-api proxy)
│   ├── server.ts           # Koa client (auth-injected)
│   ├── queries.ts          # TanStack Query hooks
│   ├── client.ts           # Shared types (Status, Stamp, etc.)
│   └── feeds.ts            # Drive metadata feed read/write
├── hooks/
│   ├── useDerivedKey.ts    # See identity.md
│   ├── useInboxPolling.ts  # See messaging.md
│   ├── useRegistryPolling.ts
│   ├── useUploadHistory.ts # localStorage upload records + folder tree
│   ├── useDriveMetadata.ts # Per-drive encrypted-state cache
│   └── useSharedDrives.ts  # Imported share-link drives
├── store/
│   ├── app.ts              # apiKey, theme, devMode, notificationSound
│   └── identity.ts         # NookSigner + safeStorage hydration (see identity.md)
├── notify/                 # Swarm Notify integration (see messaging.md)
├── crypto/
│   └── signer.ts           # NookSigner (see identity.md)
├── lib/
│   ├── utils.ts
│   └── cricket.ts          # Web Audio chirp (see messaging.md)
└── utils/                  # Tar building, directory utilities
```

### State boundaries

- **localStorage** — contacts, threads, drives, upload history, identity-published flags. Per-browser-origin (the 3002/3054 split caveat applies).
- **sessionStorage** — derived signature fallback when safeStorage isn't available.
- **Zustand stores** — in-memory app state with localStorage persistence for select fields (theme, notification preference, etc.)
- **TanStack Query** — server state (stamps, wallet, status, peers, addresses). Polled at varying intervals, retry: false on Bee endpoints.

---

## Code path quick reference

| Concern | File |
|---|---|
| Process orchestration | `src/index.ts → main()` |
| Bee subprocess spawn | `src/launcher.ts → runLauncher → launchBee → runProcess` |
| Keep-alive loop | `src/launcher.ts → runKeepAliveLoop` |
| Bee lifecycle state | `src/lifecycle.ts → BeeManager` |
| Bee config write/read | `src/config.ts` |
| Funding monitor | `src/funding-monitor.ts → startMonitorIfNeeded → switchToLightMode` |
| Chequebook monitor | `src/chequebook-monitor.ts` |
| Koa app + routes | `src/server.ts → runServer` |
| /bee-api pass-through | `src/server.ts:45` |
| Auth middleware | `src/server.ts:124` |
| Status endpoint | `src/status.ts → getStatus` |
| Identity cache (safeStorage) | `src/identity-cache.ts` |
| API key file | `src/api-key.ts` |
| Port allocation | `src/port.ts` |
| Asset paths (cross-platform) | `src/path.ts` |
| Bee downloader | `src/downloader.ts` |
| Migrations | `src/migration.ts` |
| Tray menu | `src/electron.ts` |
| Splash screen | `src/splash.ts` |
| Logger + log rotation | `src/logger.ts` |
| Deep-link handler | `src/nook-deep-link.ts` |
| Wallet operations | `src/blockchain.ts` |
| Swap | `src/swap.ts` |
| TanStack Query patterns | `ui/src/api/queries.ts` |
| Direct Bee client | `ui/src/api/bee.ts` |
| Koa client | `ui/src/api/server.ts` |
