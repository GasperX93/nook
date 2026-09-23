/**
 * Active-identity namespace for per-wallet localStorage isolation.
 *
 * Contacts, messages, invitations, invite-sent timestamps and the user's
 * display name are private to a derived Nook identity — wallet A must not see
 * wallet B's data. Rather than thread the address through ~30 call sites, the
 * storage modules build their keys via `nsKey()`, which suffixes them with the
 * currently-active derived address.
 *
 * `useDerivedKey` keeps this in sync: it calls `setActiveIdentity(addr)` with
 * the derived Nook address whenever the (address-matched) signer changes, and
 * `setActiveIdentity(null)` on disconnect/mismatch. When no identity is active
 * the keys resolve to an isolated `:__none__` bucket — always empty, so the
 * logged-out state shows nothing and no wallet's data leaks across the gap.
 *
 * Clean break: data written under the old un-suffixed keys (pre-0.4.1) is
 * simply never read again — no migration.
 */

const NONE = '__none__'

/**
 * Durable, UN-namespaced marker that some identity has been active on this
 * origin before (#65). Deliberately just an address — no key material — so
 * the logged-out UI can honestly say "messages are paused" instead of showing
 * nothing: without the key we cannot read contacts or threads at all, so this
 * flag is the only signal that there is an inbox worth unlocking.
 */
const LAST_IDENTITY_KEY = 'nook-last-identity'

let activeAddress: string | null = null

/** Set the active derived identity (lowercased), or null when none is derived. */
export function setActiveIdentity(address: string | null): void {
  activeAddress = address ? address.toLowerCase() : null

  if (activeAddress) {
    try {
      localStorage.setItem(LAST_IDENTITY_KEY, activeAddress)
    } catch {
      // Storage unavailable — the banner hint is best-effort.
    }
  }
  // Never cleared on disconnect — remembering that an identity EXISTED is the
  // whole point: it's what lets the UI warn that messages are paused.
}

/** True when some identity has been derived on this origin before. */
export function hasKnownIdentity(): boolean {
  try {
    return localStorage.getItem(LAST_IDENTITY_KEY) !== null
  } catch {
    return false
  }
}

/**
 * Swarm ID transition (#21). Before 0.7 the identity was wallet-derived; the
 * old address's contacts and threads stay under its namespace and are never
 * read again. Two durable markers let the UI explain the move:
 *
 * - SWARM_ID_SEEN_KEY: some Swarm ID identity has been active on this origin.
 *   Until it exists, a `nook-last-identity` can only be a pre-Swarm ID one.
 * - MOVED_FROM_KEY: the old address, recorded when the first Swarm ID sign-in
 *   replaced it — so Contacts can say why the list starts empty.
 */
const SWARM_ID_SEEN_KEY = 'nook-swarm-id-seen'
const MOVED_FROM_KEY = 'nook-moved-from-identity'

/** A pre-Swarm ID identity existed here and nobody has signed in with Swarm ID yet. */
export function hasLegacyIdentityPendingMove(): boolean {
  try {
    return localStorage.getItem(LAST_IDENTITY_KEY) !== null && localStorage.getItem(SWARM_ID_SEEN_KEY) === null
  } catch {
    return false
  }
}

/** True when the first Swarm ID sign-in on this origin replaced an older identity. */
export function movedFromLegacyIdentity(): boolean {
  try {
    return localStorage.getItem(MOVED_FROM_KEY) !== null
  } catch {
    return false
  }
}

/**
 * Record that a Swarm ID identity is active. Must run BEFORE setActiveIdentity
 * overwrites `nook-last-identity`, which is what still names the old address.
 */
export function markSwarmIdIdentity(address: string): void {
  try {
    if (localStorage.getItem(SWARM_ID_SEEN_KEY) !== null) return

    const previous = localStorage.getItem(LAST_IDENTITY_KEY)

    if (previous && previous !== address.toLowerCase()) localStorage.setItem(MOVED_FROM_KEY, previous)
    localStorage.setItem(SWARM_ID_SEEN_KEY, '1')
  } catch {
    // Storage unavailable — the transition hints are best-effort.
  }
}

/** The currently-active derived address (lowercased), or null. */
export function getActiveIdentity(): string | null {
  return activeAddress
}

/**
 * Namespace a base localStorage key by the active identity, e.g.
 * `nsKey('nook-contacts-v2')` → `nook-contacts-v2:0xabc…` (or `…:__none__`).
 */
export function nsKey(base: string): string {
  return `${base}:${activeAddress ?? NONE}`
}
