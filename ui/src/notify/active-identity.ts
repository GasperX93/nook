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

let activeAddress: string | null = null

/** Set the active derived identity (lowercased), or null when none is derived. */
export function setActiveIdentity(address: string | null): void {
  activeAddress = address ? address.toLowerCase() : null
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
