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

const HEX_RE = /^(0x)?[0-9a-fA-F]+$/

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

function normalizeHex(value: string, expectedHexLen: number, label: string): string {
  const stripped = value.startsWith('0x') ? value.slice(2) : value

  if (stripped.length !== expectedHexLen) {
    throw new Error(`${label}: expected ${expectedHexLen} hex chars, got ${stripped.length}`)
  }

  if (!HEX_RE.test(stripped)) {
    throw new Error(`${label}: not valid hex`)
  }

  return stripped.toLowerCase()
}

export function encodeShareLink(payload: ShareLinkPayload): string {
  const params = new URLSearchParams()

  params.set('addr', payload.ethAddress.toLowerCase())
  params.set('wpub', payload.walletPublicKey.toLowerCase())
  params.set('bpub', payload.beePublicKey.toLowerCase())

  if (payload.nickname) params.set('name', payload.nickname)

  return `nook://contact?${params.toString()}`
}

export function decodeShareLink(input: string): DecodeResult | DecodeError {
  const trimmed = input.trim()

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

    return {
      ok: true,
      payload: { ethAddress, walletPublicKey, beePublicKey, nickname: name },
    }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}
