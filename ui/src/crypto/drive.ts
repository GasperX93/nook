import { hmac } from '@noble/hashes/hmac'
import { sha256 } from '@noble/hashes/sha256'
import { keccak_256 } from '@noble/hashes/sha3'
import { secp256k1 } from 'ethereum-cryptography/secp256k1'
import { crypto as swarmNotifyCrypto } from '@swarm-notify/sdk'

export const CURRENT_WRITE_KEY_VERSION = 1

export interface WriteKey {
  privateKey: Uint8Array // 32 bytes
  publicKey: Uint8Array // 33 bytes compressed
  address: string // 0x...20 bytes ETH address of the write key
  version: number
}

/**
 * Derive the drive's writeKey from the creator's nook signing key.
 * Version is bumped (by caller) each time a writer is revoked.
 */
export function deriveWriteKey(
  creatorSigningKey: Uint8Array,
  driveId: string,
  version: number = CURRENT_WRITE_KEY_VERSION,
): WriteKey {
  const label = new TextEncoder().encode(`nook:write:${driveId}:v${version}`)
  const privateKey = hmac(sha256, creatorSigningKey, label)
  const publicKey = secp256k1.getPublicKey(privateKey, true)

  const uncompressed = secp256k1.getPublicKey(privateKey, false)
  const addressBytes = keccak_256(uncompressed.slice(1))
  const address = '0x' + bytesToHex(addressBytes.slice(-20))

  return { privateKey, publicKey, address, version }
}

/**
 * Compute the driveFeed topic from creator address + driveId.
 * Stable across writeKey rotations.
 */
export function driveFeedTopic(creatorAddress: string, driveId: string): Uint8Array {
  const normalized = creatorAddress.toLowerCase().startsWith('0x')
    ? creatorAddress.toLowerCase()
    : '0x' + creatorAddress.toLowerCase()
  const input = new TextEncoder().encode(`nook:drive:${normalized}:${driveId}`)

  return keccak_256(input)
}

export function driveFeedTopicHex(creatorAddress: string, driveId: string): string {
  return bytesToHex(driveFeedTopic(creatorAddress, driveId))
}

export async function encryptWriteKeyForWriter(
  writeKeyPriv: Uint8Array,
  writerWalletPublicKey: Uint8Array,
): Promise<Uint8Array> {
  return swarmNotifyCrypto.eciesEncrypt(writeKeyPriv, writerWalletPublicKey)
}

export async function decryptWriteKey(blob: Uint8Array, myWalletPrivateKey: Uint8Array): Promise<Uint8Array> {
  return swarmNotifyCrypto.eciesDecrypt(blob, myWalletPrivateKey)
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
}
