import type { Contact } from '@swarm-notify/sdk'

/**
 * Nook-side contact type. Wraps swarm-notify's Contact so we can:
 *   - Track how the contact was added (registry vs share link)
 *   - Stay swappable when Swarm ID replaces NookSigner (per project memory rule 3)
 *
 * All three identity fields (ethAddress, walletPublicKey, beePublicKey) are
 * REQUIRED by construction. Mandatory wallet means every Nook user has
 * everything; opted-out users share via share-link instead of registry.
 */
export interface NookContact {
  /** Canonical key — Nook (ETH) address, lowercased */
  id: string
  /** User-assigned nickname */
  nickname: string
  /** Compressed secp256k1 public key (66 hex chars) — for ECDH messaging */
  walletPublicKey: string
  /** Bee node public key — for ACT grants */
  beePublicKey: string
  /** ENS name if known */
  ensName?: string
  /** How this contact was added — for UX badges + future reasoning */
  source: 'identity-feed' | 'share-link'
  /** Unix timestamp ms */
  addedAt: number
}

/**
 * Convert a Nook contact to the swarm-notify Contact shape for library calls.
 * Library API is the authoritative type; this adapter exists so future
 * NookContact extensions don't churn library call sites.
 */
export function toLibraryContact(c: NookContact): Contact {
  return {
    ethAddress: c.id,
    nickname: c.nickname,
    walletPublicKey: c.walletPublicKey,
    beePublicKey: c.beePublicKey,
    ensName: c.ensName,
    addedAt: c.addedAt,
  }
}
