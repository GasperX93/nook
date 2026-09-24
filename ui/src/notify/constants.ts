export const REGISTRY_ADDRESS = '0x318aE190B77bA39fbcdFA4e84BB7CFD16b846Fcf'

export const GNOSIS_CHAIN_ID = 100

export const GNOSIS_RPC_URL = 'https://rpc.gnosischain.com'

/**
 * Independent fallback for browser-side Gnosis reads (R5-3/R5-14). Same pair
 * as the backend relay (src/rpc-endpoints.ts): publicnode runs on separate
 * infrastructure, so it isn't throttled when rpc.gnosischain.com is.
 * (rpc.gnosis.gateway.fm is only an alias of rpc.gnosischain.com.)
 */
export const GNOSIS_RPC_FALLBACK_URL = 'https://gnosis-rpc.publicnode.com'

/**
 * Block the notification registry was deployed at on Gnosis (creation tx
 * 0x6aa1bf6284ee0ffb2a6bc3d325835e2605d3db2bfaab5d30fc656feee7c03985,
 * 2026-04-20). Used as the floor for registry log scans so a fresh install
 * never queries eth_getLogs from genesis (~45.7M blocks of wasted scanning).
 */
export const REGISTRY_DEPLOY_BLOCK = 45_769_790
