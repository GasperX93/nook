/**
 * `nook://contact?…` deep link encoding for sharing identity manually.
 *
 * Format:
 *   nook://contact?addr=<eth20>&wpub=<compressed33>&bpub=<compressed33>&name=<nickname>
 *
 * `addr`, `wpub`, `bpub` are required. `name` is optional.
 * All hex values are case-insensitive; the parser lowercases addresses for
 * canonicalization.
 */

import { secp256k1 } from 'ethereum-cryptography/secp256k1'
import { keccak256 } from 'ethereum-cryptography/keccak'

import { bytesToHex } from '../lib/hex'

const HEX_RE = /^(0x)?[0-9a-fA-F]+$/

/**
 * Recompute the ETH address that a compressed wallet public key derives to,
 * mirroring `createWalletSigner` in crypto/signer.ts:
 *   address = '0x' + keccak256(uncompressedPubKey[1:])[-20:]
 * Throws if `compressedWpub` is not a valid point on the secp256k1 curve.
 */
function addressFromWalletPubKey(compressedWpub: string): string {
  const uncompressed = secp256k1.ProjectivePoint.fromHex(compressedWpub).toRawBytes(false)

  return '0x' + bytesToHex(keccak256(uncompressed.slice(1)).slice(-20))
}

export interface ShareLinkPayload {
  /** Nook (ETH) address — 20 bytes, lowercased */
  ethAddress: string
  /** Compressed secp256k1 wallet public key — 33 bytes hex */
  walletPublicKey: string
  /** Compressed Bee node public key — 33 bytes hex */
  beePublicKey: string
  /** Suggested nickname (from sender) */
  nickname?: string
}

export interface DecodeResult {
  ok: true
  payload: ShareLinkPayload
}

export interface DecodeError {
  ok: false
  error: string
}

export function normalizeHex(value: string, expectedHexLen: number, label: string): string {
  const stripped = value.startsWith('0x') ? value.slice(2) : value

  if (stripped.length !== expectedHexLen) {
    throw new Error(`${label}: expected ${expectedHexLen} hex chars, got ${stripped.length}`)
  }

  if (!HEX_RE.test(stripped)) {
    throw new Error(`${label}: not valid hex`)
  }

  return stripped.toLowerCase()
}

/**
 * Contact-link URL scheme is versioned so future readers can distinguish
 * payload shapes. v1: addr + wpub + bpub. A future v2 might drop bpub
 * (resolved via identity feed) once Swarm ships portable stamps + ACT
 * with external signers.
 */
export function encodeShareLink(payload: ShareLinkPayload): string {
  const params = new URLSearchParams()

  params.set('addr', payload.ethAddress.toLowerCase())
  params.set('wpub', payload.walletPublicKey.toLowerCase())
  params.set('bpub', payload.beePublicKey.toLowerCase())

  if (payload.nickname) params.set('name', payload.nickname)

  return `nook://contact/v1?${params.toString()}`
}

export function decodeShareLink(input: string): DecodeResult | DecodeError {
  const trimmed = input.trim()

  // Accept both the v1 path (`nook://contact/v1?...`) and the legacy
  // unversioned form (`nook://contact?...`) for backwards compatibility.
  if (!trimmed.startsWith('nook://contact')) {
    return { ok: false, error: 'Not a Nook contact link (must start with nook://contact)' }
  }

  // URLSearchParams needs a parseable URL — replace the custom scheme with http: temporarily
  let params: URLSearchParams

  try {
    const url = new URL(trimmed.replace(/^nook:/, 'https:'))

    params = url.searchParams
  } catch {
    return { ok: false, error: 'Malformed URL' }
  }

  const addr = params.get('addr')
  const wpub = params.get('wpub')
  const bpub = params.get('bpub')
  const name = params.get('name') ?? undefined

  if (!addr || !wpub || !bpub) {
    return { ok: false, error: 'Missing required field (addr, wpub, or bpub)' }
  }

  try {
    const ethAddress = '0x' + normalizeHex(addr, 40, 'addr')
    const walletPublicKey = normalizeHex(wpub, 66, 'wpub')
    const beePublicKey = normalizeHex(bpub, 66, 'bpub')

    // Security (D1): the wallet public key is cryptographically bound to the
    // address (address = keccak256(uncompressed(wpub))[-20:]). Verify it here,
    // otherwise an attacker could craft a link pairing a *victim's* address
    // with their *own* wpub — the UI would show the victim's address while
    // every message the user sends gets encrypted to (and readable by) the
    // attacker, and the on-chain wake-up would target the attacker's key.
    // (mailbox.send + registry.sendNotification both key off walletPublicKey.)
    let derivedAddress: string

    try {
      derivedAddress = addressFromWalletPubKey(walletPublicKey)
    } catch {
      return { ok: false, error: 'Invalid contact link: malformed wallet public key' }
    }

    if (derivedAddress !== ethAddress) {
      return { ok: false, error: 'Invalid contact link: the wallet key does not match the address' }
    }

    // NOTE: bpub (the Bee node key, used for ACT drive encryption) is a
    // separate node key and is NOT derivable from the address, so it cannot be
    // bound the same way. ACT sharing via this link remains trust-on-first-use;
    // only accept contact links from a trusted channel for drive sharing.
    return {
      ok: true,
      payload: { ethAddress, walletPublicKey, beePublicKey, nickname: name },
    }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}
