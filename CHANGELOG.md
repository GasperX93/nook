# Changelog

## [0.3.5](https://github.com/GasperX93/nook/releases/tag/v0.3.5) (2026-03-12)

### Dependency upgrades

* Electron 18 → 41 — latest Chromium, better security and performance
* bee-js 8 → 11 — updated to match Bee v2.7.0 API
* Vite 5 → 7 — faster UI builds, resolved CJS deprecation warning
* TypeScript 5.3 → 5.9 — required for bee-js v11 generics
* Electron Forge 6 → 7 — improved packaging, proper devDependency pruning
* Housekeeping: prettier 3, fs-extra 11, concurrently 9, uuid 10, lucide-react 0.577, rimraf 6, cross-env 10, file-stream-rotator 1
* Patch bumps: koa, winston, js-yaml, viem, autoprefixer, postcss, tailwindcss

### Bug fixes

* Drive search now only shows files from active drives (previously showed files from expired stamps)

### Cleanup

* Removed unused `/price` endpoint (tokenservice.ethswarm.org is down, UI never called it)
* Removed inherited screenshot plugin (never wired into Nook)
* Excluded ~40 dev-only module scopes from packaged asar (smaller install footprint)

## [0.3.4](https://github.com/GasperX93/nook/releases/tag/v0.3.4) (2026-03-11)

### Features

* Global RainbowKit ConnectButton in top bar with dropdown (copy address, disconnect)
* ENS avatar shown in wallet button
* Page titles in top bar
* ENS domain linking for published websites — link from Drive or Publish page
* Auto chain switch — prompts wallet to switch to Ethereum mainnet when needed
* "Already set" detection when content hash already matches
* Only one website can own a domain — duplicates are auto-cleared
* Website badge on drive cards to distinguish websites from regular files

### Reliability

* Friendly error messages for transaction failures (redeem, withdraw, swap)

## [0.3.3](https://github.com/GasperX93/nook/releases/tag/v0.3.3) (2026-03-10)

### Features

* True ultra-light mode — new installs start with no blockchain connection, Bee API available immediately
* Postage sync now takes ~2–3 minutes (down from ~11 minutes) thanks to clean snapshot loading
* Funding monitor auto-detects wallet balance and restarts Bee in light mode
* RPC fallback for gift code redeem, withdraw, and swap when config has no RPC endpoint
* "Exit Developer Mode" button on Developer page

## [0.3.2](https://github.com/GasperX93/nook/releases/tag/v0.3.2) (2026-03-10)

### Bug fixes

* "Create your first drive" now navigates to the Drive page (was going to Account)
* Syncing step waits for node to fully switch to light mode before showing "ready"
* "Insufficient BZZ" warning no longer flashes briefly during drive purchase
* Better error messages when creating a drive while node is still starting or syncing

### UI improvements

* Wallet page: single-column layout — Top Up widget above Redeem Gift Code
* Top Up widget is collapsible with accent-colored header and wallet icon
* Funding banner shows for existing users with empty wallets

## [0.3.1](https://github.com/GasperX93/nook/releases/tag/v0.3.1) (2026-03-06)

### Features

* Ultra-light mode startup — Bee starts without blockchain connection, API available immediately
* Backend funding monitor polls wallet balance every 15s, auto-switches to light mode when funded

### UI improvements

* Updated copy: BZZ → xBZZ across wallet page
* Removed screenshot plugin from tray menu
* Hidden broken swap UI (will be re-enabled when fixed)
* Simplified status banners

## [0.3.0](https://github.com/GasperX93/nook/releases/tag/v0.3.0) (2026-03-05)

### Features

* Onboarding wizard — full-screen setup flow for first-time users
* Embedded multichain widget and gift code redemption in onboarding
* Withdraw funds — send BZZ or xDAI to any external address
* Realistic drive capacity — effective (usable) sizes instead of theoretical maximums
* New drive presets: 110 MB, 680 MB, 2.6 GB, 7.7 GB
* "Full" badge when a drive can no longer accept uploads
* Download progress percentage for large files
* Extend drive error messages and immediate TTL update
* GitHub and feedback links in Settings > About

## [0.2.0](https://github.com/GasperX93/nook/releases/tag/v0.2.0) (2026-03-03)

### Features

* Navigation & layout overhaul — sidebar with icon labels, Apps section
* Website Publisher moved to dedicated app under Apps
* Drive is now the home for all file and folder uploads
* Folder tree with nesting indicator
* Website Publisher: live upload progress, feed toggle with permanent address, mutable stamps
* Wallet page separated from Account

## [0.1.1](https://github.com/GasperX93/nook/releases/tag/v0.1.1) (2026-03-03)

### Bug Fixes

* Redeem gift code: re-fetch xDAI balance after BZZ transfer to avoid "insufficient funds" error
* Redeem gift code: empty or already-redeemed codes now show a clear error message
* Redeem gift code: UI showed "500 Internal Server Error" instead of the actual error message
* Wallet balance now refreshes immediately after a successful redeem

## [0.1.0](https://github.com/GasperX93/nook/releases/tag/v0.1.0) (2026-03-01)

### Features

* Initial public release
* Publish files, folders, and static websites to Swarm
* Drive — organise uploads in folders and subfolders
* Feeds — permanent feed address that updates on new publish
* Wallet — xDAI and BZZ balance, swap, redeem gift codes, multichain top-up
* My Storage — manage drives, TTL bars, extend before expiry
* Settings — RPC endpoint, network stats, developer mode
* Auto-download and manage Bee node binary
