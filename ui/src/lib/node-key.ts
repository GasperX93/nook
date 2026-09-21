import type { NookContact } from '../notify/types'

/**
 * Node-key ↔ contact matching (#122).
 *
 * A drive's grantee list stores BEE NODE public keys, but notifications go to
 * a contact's NOOK identity (wallet-derived). When someone re-derives their
 * identity on the same machine, two contacts end up sharing one node key —
 * and a first-found lookup routes the share notification to the STALE
 * identity's mailbox, which nobody reads (live-diagnosed in #122).
 *
 * `contactsForNodeKey` therefore returns ALL matches, newest first: callers
 * use [0] as the best guess for the person's current identity and can surface
 * the ambiguity when there's more than one.
 */

/**
 * Normalize a secp256k1 public key to its X coordinate (64 hex chars) so
 * compressed (02/03…), uncompressed (04…), and prefixless forms compare equal.
 */
export function stripKeyPrefix(k: string): string {
  const clean = k.toLowerCase().replace('0x', '')

  if (clean.length === 66 && (clean.startsWith('02') || clean.startsWith('03'))) {
    return clean.slice(2)
  }

  if (clean.length === 130 && clean.startsWith('04')) {
    return clean.slice(2, 66)
  }

  if (clean.length === 128) {
    return clean.slice(0, 64)
  }

  return clean
}

/** All contacts whose Bee node key matches, newest (most recently added) first. */
export function contactsForNodeKey(contacts: NookContact[], nodeKey: string): NookContact[] {
  const keyX = stripKeyPrefix(nodeKey)

  return contacts.filter(c => stripKeyPrefix(c.beePublicKey) === keyX).sort((a, b) => b.addedAt - a.addedAt)
}

/**
 * The contact whose SUPERSEDED node key matches (see NookContact.previousBeeKeys)
 * — identifies a stale grant as "this person's old key" after their reinstall.
 */
export function contactForOldNodeKey(contacts: NookContact[], nodeKey: string): NookContact | undefined {
  const keyX = stripKeyPrefix(nodeKey)

  return contacts.find(c => (c.previousBeeKeys ?? []).some(k => stripKeyPrefix(k) === keyX))
}
