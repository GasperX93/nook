# Nook vs. Swarm Desktop — Analysis Report

> **Date:** February 2026
> **Author:** Claude Code analysis
> **Scope:** Feature comparison between Nook (this repo) and the original swarm-desktop by Swarm Association (`ethersphere/swarm-desktop`)

---

## Background

Nook started as a fork of **swarm-desktop** (`ethersphere/swarm-desktop`), the official Swarm Foundation desktop node manager. The `package.json` still credits Swarm Association as a contributor and lists their repo as the upstream.

The original swarm-desktop bundled the **bee-dashboard** npm package (`@ethersphere/bee-dashboard`) as its entire UI — a full-featured Bee node administration interface. Nook replaces that with a custom, lightweight React app focused on consumer storage workflows.

The key rebrand commits (`d666626`, `f77ed56`) removed the bee-dashboard dependency entirely and rewrote the frontend from scratch.

---

## What Changed and Why

### 1. Frontend Architecture

| | Swarm Desktop | Nook |
|---|---|---|
| **UI package** | `@ethersphere/bee-dashboard` (pre-built npm package) | Custom React app (`ui/`) |
| **Build tool** | CRA / bundled | Vite + TypeScript |
| **Styling** | bee-dashboard CSS | Tailwind CSS + CSS custom properties |
| **State management** | bee-dashboard internal | Zustand (minimal: API key + gateway URL) |
| **Data fetching** | bee-dashboard internal | TanStack Query v5 |
| **Icons** | bee-dashboard icons | Lucide React |
| **React version** | React 18 | React 19 |
| **Pages** | Full Bee node admin UI | 7 focused pages (see below) |

**Why:** bee-dashboard is a developer/node-operator tool. Nook targets consumers who want to store files — not manage a node. The swap removes 40+ screens of node internals for 7 clean, task-oriented pages.

---

### 2. Navigation — Pages Removed

The bee-dashboard UI had tabs covering every aspect of node operation:

| bee-dashboard Tab | Status in Nook |
|---|---|
| Dashboard / Overview | Simplified → single status row in sidebar |
| Files (basic upload) | Replaced → full Publish wizard |
| PSS (messaging) | **Removed** |
| Feeds (manual) | Integrated into Publish wizard |
| Accounting & Chequebook | **Removed** |
| Peers / Topology | **Removed** (peer count visible in Overview) |
| Node info / addresses | Partially kept in Account → Wallet tab |
| Stamps (admin view) | Replaced → Account → My Storage tab |
| Settings / Config | Kept as JSON editor |
| Debug API explorer | **Removed** |

**Why:** PSS, chequebook cashout, peer management, and topology are node-operator concerns. A consumer user does not need to manage cheques or peer connections.

---

### 3. Navigation — Pages Added

| Nook Page | Description |
|---|---|
| **Publish** | Multi-step wizard: select content → pick/buy stamp → optional feed → upload with progress |
| **Drive** | Upload history with folders, drag-and-drop organisation, per-file TTL bar, feed update |
| **Account** | Combined page: Wallet tab + My Storage tab |
| **My Storage** (Account tab) | Stamp management: list drives with TTL bar/usage, top up, buy new stamp with label |
| **Developer** | Node config editor + real-time Bee logs in one page (dev mode only) |
| **Logs** | Real-time Bee + Desktop log viewer with two tabs |

**Why:** Publish, Drive, and Account cover the full consumer loop: upload → organise → manage storage. Logs are retained because they are the primary debugging tool.

---

### 4. Tray Menu

| Item | Swarm Desktop | Nook |
|---|---|---|
| Open Web UI | ✅ | ✅ |
| Start / Stop Bee | ✅ | ✅ |
| Apps submenu | ✅ (FDP, Datafund, Etherjot, Devcon.buzz, decentralised Wiki/OSM) | ❌ Removed |
| Screenshot tool | ✅ | ✅ (renamed "Nook Screenshot") |
| Logs (opens folder) | ✅ | ✅ |
| Quit | ✅ | ✅ |

**Why:** The Apps submenu linked to Swarm Foundation ecosystem dApps. These are external services unrelated to Nook's core purpose.

---

### 5. Backend API — Changes

| Endpoint | Swarm Desktop | Nook |
|---|---|---|
| `GET /info` | ✅ | ✅ (name: `nook`) |
| `GET /status` | ✅ | ✅ |
| `GET /price` | ✅ | ✅ |
| `GET /peers` | ✅ | ✅ |
| `GET /config` | ✅ | ✅ |
| `POST /config` | ✅ | ✅ |
| `GET /logs/*` | ✅ | ✅ |
| `POST /restart` | ✅ | ✅ |
| `POST /swap` | ✅ | ✅ |
| `POST /redeem` | ✅ | ✅ |
| `POST /buy-stamp` | Basic | ✅ Enhanced — supports `label`, routes through backend to fix Electron header stripping |
| `POST /feed-update` | ❌ | ✅ New — signs SOC server-side using Bee node private key |
| `/fdp` and app routes | ✅ | ❌ Removed |

**Why:** `/feed-update` was added because Electron's renderer process strips custom HTTP headers on localhost requests, making it impossible to sign feed updates from the UI directly.

---

### 6. Wallet / Blockchain

| Feature | Swarm Desktop | Nook |
|---|---|---|
| BZZ balance | ✅ | ✅ |
| xDAI balance | ✅ | ✅ |
| Wallet address + copy | ✅ | ✅ |
| xDAI → BZZ swap | ✅ | ✅ |
| Gift code redemption | ✅ | ✅ |
| Cross-chain top-up widget | ❌ | ✅ `@upcoming/multichain-widget` — fund from any chain/token |
| Chequebook balance | ✅ | ❌ Removed |
| Cashout cheques | ✅ | ❌ Removed |
| Transaction history | ✅ (bee-dashboard) | ❌ Removed |

**Why:** Chequebook management is a node-operator concern. The multichain widget replaces it with a consumer-friendly top-up flow that accepts any chain or token.

---

### 7. Stamp / Storage Management

| Feature | Swarm Desktop | Nook |
|---|---|---|
| Buy stamp | ✅ Basic | ✅ Enhanced (label, routed through backend) |
| Stamp list | ✅ (bee-dashboard) | ✅ My Storage tab in Account page |
| Top up stamp | ✅ | ✅ |
| Stamp TTL display | ✅ | ✅ TTL bar with color coding (green/orange/red) |
| Utilization display | ✅ | ✅ |
| Stamp label (name) | ❌ | ✅ Added |
| Immutable/mutable badge | ❌ | ✅ Added |
| Pending stamp indicator | ❌ | ✅ "Confirming…" pulse while stamp becomes usable |
| Mutable/immutable toggle at buy | ❌ | ✅ Added |
| Stamp dilution (increase depth) | ✅ (bee-dashboard) | ❌ Removed |
| Batch transfer | ✅ (bee-dashboard) | ❌ Removed |

**Why:** Dilute/transfer are advanced operations. Nook simplifies stamp UI to what a consumer needs: buy, name, top up, monitor expiry.

---

### 8. CI/CD and GitHub Workflows

| | Swarm Desktop | Nook |
|---|---|---|
| GitHub Actions (assets build) | ✅ | ❌ Removed |
| GitHub Actions (check/lint) | ✅ | ❌ Removed |
| GitHub Actions (pre-release) | ✅ | ❌ Removed |
| GitHub Actions (tests) | ✅ | ❌ Removed |
| macOS cert signing script | ✅ | ❌ Removed |
| Semantic PR title check | ✅ | ✅ Kept (`semantic.yml`) |

**Why:** All 4 inherited workflows referenced `@ethersphere/bee-dashboard`, `REACT_APP_FORMBRICKS_*` secrets, and old publish scripts that do not apply to Nook. Removed to clean up the repo. Build and release are currently done locally with `npm run make`.

---

### 9. Error Tracking

| | Swarm Desktop | Nook |
|---|---|---|
| Sentry integration | ✅ | ❌ Removed (commit `a98eb59`) |
| Source map uploads | ✅ (CI) | ❌ Removed |

**Why:** Removed to simplify build pipeline and avoid sending error data to a third party.

---

### 10. Installer Flow

| | Swarm Desktop | Nook |
|---|---|---|
| Separate installer UI | ✅ (with faucet drip, BZZ deposit) | ❌ Removed |
| Faucet integration | ✅ | ❌ Removed |
| First-run setup wizard | ✅ | ❌ — Bee starts automatically |

**Why:** Faucet integration was specific to testnet onboarding. Nook targets mainnet users who fund their node via the swap feature, gift codes, or the multichain top-up widget.

---

### 11. Configuration

**Bee config keys removed by Nook migrations (auto-deleted on startup):**

| Removed Key | Reason |
|---|---|
| `admin-password` | Deprecated in Bee 2.0 |
| `debug-api-addr` | Removed in Bee 2.0 |
| `debug-api-enable` | Removed in Bee 2.0 |
| `skip-postage-snapshot` | Legacy |
| `chain-enable` | Replaced by `swap-enable` |
| `swap-endpoint` | Replaced by `blockchain-rpc-endpoint` |
| `block-hash`, `transaction` | Legacy swap fields |

**Config keys added by Nook migrations:**

| Key | Value | Reason |
|---|---|---|
| `swap-enable` | `true` | Required for wallet endpoints |
| `blockchain-rpc-endpoint` | `https://xdai.fairdatasociety.org` | Required for xDAI/BZZ swap |

---

### 12. Data & Log Paths

| | Swarm Desktop | Nook |
|---|---|---|
| macOS data | `~/Library/Application Support/Swarm Desktop/` | `~/Library/Application Support/Nook/` |
| macOS logs | `~/Library/Logs/Swarm Desktop/` | `~/Library/Logs/Nook/` |
| Windows data | `%LOCALAPPDATA%\Swarm Desktop\Data` | `%LOCALAPPDATA%\Nook\Data` |
| Windows logs | `%LOCALAPPDATA%\Swarm Desktop\Log\` | `%LOCALAPPDATA%\Nook\Log\` |
| Linux data | `~/.local/share/Swarm Desktop/` | `~/.local/share/Nook/` |
| Linux logs | N/A | `~/.local/state/Nook/` |

Users migrating from swarm-desktop to Nook must manually move their Bee data directory or update the `data-dir` config key.

---

## Features Missing in Nook vs. Swarm Desktop / bee-dashboard

These features exist in the original swarm-desktop or bee-dashboard and are **not present in Nook**:

### Node Management (Not Consumer-Relevant)
- **Peer list** — view connected peers, manually add/remove
- **Topology / neighbourhood** — view kademlia depth and saturation
- **Chequebook management** — balance, peer cheques, cashout
- **Accounting** — per-peer compensation stats

### Storage (Advanced)
- **Stamp dilution** — increase the depth (capacity) of an existing stamp
- **Batch transfer** — move a stamp to a different node

### Communication
- **PSS** — Swarm's peer-to-peer messaging protocol

### Developer / Debug
- **Debug API explorer** — direct HTTP interface to Bee debug endpoints
- **Node addresses page** — full display of overlay, underlay, PSS pub key, etc.

### Ecosystem
- **Apps submenu** — direct links to ecosystem dApps (FDP, Datafund, Etherjot, etc.)

### Onboarding
- **Installer UI with faucet** — guided first-run with testnet faucet drip

### Observability
- **Sentry error reporting** — crash reports sent to remote service
- **Transaction history** — past swap/redeem operations

---

## Open GitHub Issues

| # | Title | Status |
|---|---|---|
| [#1](https://github.com/GasperX93/nook/issues/1) | Wallet: add RainbowKit ConnectButton above Top Up widget | Open |

---

## Summary

Nook is a **deliberate, consumer-focused fork** of swarm-desktop. It drops everything a node operator needs but a file storage user does not, and adds workflows (Publish wizard, Drive organiser, feed publishing, stamp labels, cross-chain top-up) that the original never had.

| Dimension | Swarm Desktop | Nook |
|---|---|---|
| **Target user** | Node operators, developers | Consumers, file storers |
| **UI philosophy** | Full admin panel (bee-dashboard) | Task-oriented wizard |
| **Unique to Nook** | — | Publish wizard, Drive with folders, Account/My Storage, stamp labels, feed publishing, multichain top-up widget |
| **Unique to swarm-desktop** | Full node admin, chequebook, PSS, apps submenu, faucet onboarding | — |
| **Shared** | Wallet (BZZ/xDAI), swap, redeem, logs, settings, auto-update | |
