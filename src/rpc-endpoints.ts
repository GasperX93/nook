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

/** Endpoints Nook itself wrote as defaults in earlier versions. */
const LEGACY_DEFAULTS = ['https://rpc.gnosischain.com', 'https://xdai.fairdatasociety.org']

/** True when the config value means "Nook picks the RPC" (relay, legacy default or unset). */
export function isAutomaticRpc(value: unknown): boolean {
  return typeof value !== 'string' || value === '' || value === RPC_RELAY_URL || LEGACY_DEFAULTS.includes(value)
}
