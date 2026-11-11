---
description: Check all Nook dependencies, external services, and Bee binary for updates
allowed-tools: [Read, Grep, Glob, Bash, Agent]
---

Run a comprehensive dependency and service health check for Nook. Execute ALL of the following checks and present a single consolidated report at the end.

## 1. Bee Binary Version

- Read `src/downloader.ts` and take the current Bee version from `EXPECTED_BEE_VERSION`
- Run: `gh api repos/ethersphere/bee/releases/latest --jq '{tag_name, published_at}'` to get the latest release and its date
- Compare and flag if outdated; apply the waiting period (section 7) to the latest release

## 2. npm Outdated (Backend)

- Run: `npm outdated --json` in the project root
- Parse output: group by update type (patch / minor / major)
- Flag these as HIGH RISK if major update available: `@ethersphere/bee-js`, `ethers`, `electron`, `koa`
- Flag `etherchunk` as HIGH RISK on ANY update (it is exact-pinned; see Key Update Rules) and also check its upstream issue tracker: `gh issue list --repo Cafe137/etherchunk --state open` — open issues there may be release-blocking for reclaimable drives

## 3. npm Outdated (Frontend)

- Run: `cd ui && npm outdated --json`
- Parse output: group by update type (patch / minor / major)
- Flag these as HIGH RISK if major update available: `wagmi`, `viem`, `@rainbow-me/rainbowkit`, `react`, `@upcoming/multichain-widget`

## 4. Web3 Peer Dependency Check

These three packages MUST be updated together — check compatibility:
- `wagmi` requires specific `viem` version (check `node_modules/wagmi/package.json` peerDependencies)
- `@rainbow-me/rainbowkit` requires specific `wagmi` version (check `node_modules/@rainbow-me/rainbowkit/package.json` peerDependencies)
- Report whether current installed versions satisfy each other's peer deps

## 5. External Service Health

Test each endpoint and report status:

### RPCs
- `curl -s -o /dev/null -w "%{http_code}" -X POST -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}' https://rpc.gnosischain.com`
- `curl -s -o /dev/null -w "%{http_code}" -X POST -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}' https://ethereum-rpc.publicnode.com`

### ENS Subgraph
- Read the API key and subgraph URL from `ui/src/components/ENSModal.tsx`
- Run: `curl -s -o /dev/null -w "%{http_code}" -X POST -H "Content-Type: application/json" -H "Authorization: Bearer {KEY}" -d '{"query":"{ _meta { block { number } } }"}' {SUBGRAPH_URL}`

### Swarm Gateway
- `curl -s -o /dev/null -w "%{http_code}" https://gateway.ethswarm.org`

## 6. Nook Version Check

- Read version from `package.json`
- Run: `gh api repos/GasperX93/nook/releases/latest --jq '.tag_name'` to check latest published release
- Compare with current

## 7. Waiting Period (7 days)

A new version is not recommended until it has been public for 7 full days. Check the age of every version you are about to recommend — the Bee release and each npm package in the Recommendations list (not every outdated package):

- Bee: `published_at` from section 1
- npm: `npm view <package> time --json` — the date next to the target version
- Younger than 7 days → status **WAIT**, with the date it becomes eligible. Do not recommend it for this round; if an older, eligible version is also newer than the installed one, recommend that instead.
- When the update is made, re-check the date: the version being installed must be at least 7 days old on that day.

**Exception — the user decides, never automatic:** a security fix, or an upgrade the network requires (the old version stops working). Report it as WAIT with the reason it may be urgent, and before recommending it early confirm: the release notes say what it fixes; it comes from the usual maintainers; for Bee, the checksums in `bee_<version>_checksums.txt` and the GitHub asset digests agree.

## Report Format

Present results as a single report:

```
## Nook Dependency Check — {today's date}

### Bee Binary
- Current: vX.Y.Z | Latest: vX.Y.Z (published YYYY-MM-DD) | Status: up-to-date / UPDATE AVAILABLE / WAIT until YYYY-MM-DD

### Nook App
- Current: X.Y.Z | Latest release: vX.Y.Z

### Backend Packages (major updates only — skip patch/minor unless security-related)
| Package | Current | Latest | Type | Notes |
|---------|---------|--------|------|-------|

### Frontend Packages (major updates only — skip patch/minor unless security-related)
| Package | Current | Latest | Type | Notes |
|---------|---------|--------|------|-------|

### Web3 Stack Compatibility
- wagmi X.Y.Z requires viem ^A.B.C — {OK / MISMATCH}
- RainbowKit X.Y.Z requires wagmi ^A.B.C — {OK / MISMATCH}

### External Services
| Service | URL | Status | Response |
|---------|-----|--------|----------|
| Gnosis RPC | rpc.gnosischain.com | OK / DOWN | HTTP {code} |
| Ethereum RPC | ethereum-rpc.publicnode.com | OK / DOWN | HTTP {code} |
| ENS Subgraph | gateway.thegraph.com | OK / DOWN | HTTP {code} |
| Swarm Gateway | gateway.ethswarm.org | OK / DOWN | HTTP {code} |

### Recommendations
{Prioritized list: what to update first, what can wait, what NOT to touch. For each recommended version give its publish date; versions younger than 7 days are listed as WAIT with the eligible date}
```

## Key Update Rules (reference when making recommendations)

- **Waiting period**: nothing younger than 7 days — npm packages and the Bee binary alike (section 7). Early only for a security fix or a required network upgrade, and only on the user's decision
- **Bee binary**: a bump replaces `EXPECTED_BEE_VERSION` AND all checksums in `BEE_SHA256` (`src/downloader.ts`), taken from the release's `bee_<version>_checksums.txt` and cross-checked with the GitHub asset digests
- **ethers**: DO NOT recommend upgrading to v6 — completely different API, requires full refactor
- **wagmi + viem + RainbowKit**: Must be updated TOGETHER as a group
- **@upcoming/multichain-widget**: Check if external wagmi context was added before recommending update
- **bee-js**: Must stay compatible with the Bee binary version
- **etherchunk**: the reclaimable-drive engine (#99), exact-pinned on purpose — NEVER auto-bump. Any update must follow the full procedure: `npm i --save-exact etherchunk@<new>`, dist-diff the installed package against the previous version (especially `registry.js`/`slots.js` — byte-identical means no ledger/state migration; changes there mean STOP and plan a migration), confirm the `upload`/`deleteFile`/`list`/`status` surface still matches `EtherchunkModule` in `src/reclaimable.ts`, then live-retest upload → delete → slot-reuse before merging. Its fixes sometimes ride in via its only dep `cafe-utility`, so check that bump too. Repo: Cafe137/etherchunk (no GitHub releases — use `npm view etherchunk version` for latest)
- **React**: Check all UI deps support the new version before recommending
- **Electron**: Major updates may break native modules and forge config

## Reference

Full dependency documentation: `/Users/gzupan/Downloads/Repos/spindle/projects/nook/notes/reference/dependencies.md`
