---
description: Check all Nook dependencies, external services, and Bee binary for updates
allowed-tools: [Read, Grep, Glob, Bash, Agent]
---

Run a comprehensive dependency and service health check for Nook. Execute ALL of the following checks and present a single consolidated report at the end.

## 1. Bee Binary Version

- Read `src/downloader.ts` and extract the current Bee version from the download URL
- Run: `gh api repos/ethersphere/bee/releases/latest --jq '.tag_name'` to get the latest release
- Compare and flag if outdated

## 2. npm Outdated (Backend)

- Run: `npm outdated --json` in the project root
- Parse output: group by update type (patch / minor / major)
- Flag these as HIGH RISK if major update available: `@ethersphere/bee-js`, `ethers`, `electron`, `koa`

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

## Report Format

Present results as a single report:

```
## Nook Dependency Check — {today's date}

### Bee Binary
- Current: vX.Y.Z | Latest: vX.Y.Z | Status: up-to-date / UPDATE AVAILABLE

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
{Prioritized list: what to update first, what can wait, what NOT to touch}
```

## Key Update Rules (reference when making recommendations)

- **ethers**: DO NOT recommend upgrading to v6 — completely different API, requires full refactor
- **wagmi + viem + RainbowKit**: Must be updated TOGETHER as a group
- **@upcoming/multichain-widget**: Check if external wagmi context was added before recommending update
- **bee-js**: Must stay compatible with the Bee binary version
- **React**: Check all UI deps support the new version before recommending
- **Electron**: Major updates may break native modules and forge config

## Reference

Full dependency documentation: `/Users/gzupan/Downloads/Repos/spindle/projects/nook/notes/dependencies.md`
