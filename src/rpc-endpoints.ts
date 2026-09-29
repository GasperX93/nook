/**
 * Gnosis RPC endpoints Nook uses by default, and how to tell "automatic" from
 * a custom RPC the user set. Dependency-free on purpose: migration.ts and the
 * funding monitor import it, and it must load in unit tests that mock config.
 * The relay and the reasoning behind these endpoints live in rpc.ts.
 */
export const RPC_PRIMARY = 'https://rpc.gnosischain.com'
export const RPC_FALLBACK = 'https://gnosis-rpc.publicnode.com'

/** Nook's port is pinned (src/port.ts) — changing it would rotate identities. */
export const RELAY_PORT = 3054
export const RPC_RELAY_URL = `http://127.0.0.1:${RELAY_PORT}/rpc`

/**
 * Endpoints Nook itself wrote as defaults in earlier versions. Only the
 * one-time migration (migration.ts) moves these to the relay — afterwards the
 * same URL in the config is a choice the user made in Settings (R6-1).
 */
export const LEGACY_DEFAULT_RPCS = ['https://rpc.gnosischain.com', 'https://xdai.fairdatasociety.org']

/** True when the config value means "Nook picks the RPC" (relay or unset). */
export function isAutomaticRpc(value: unknown): boolean {
  return typeof value !== 'string' || value === '' || value === RPC_RELAY_URL
}
