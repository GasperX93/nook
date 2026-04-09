/**
 * NookSigner — wallet-derived cryptographic identity for Nook.
 *
 * Derives purpose-specific keys from a single wallet signature using HMAC-SHA256.
 * One signature → multiple independent keys (signing, encryption, ECDH).
 *
 * The signer interface is designed to be swappable — replace WalletDerivedSigner
 * with a SwarmIdSigner in the future without changing consuming code.
 */
import { secp256k1 } from 'ethereum-cryptography/secp256k1'
import { keccak256 } from 'ethereum-cryptography/keccak'
import { hmac } from '@noble/hashes/hmac'
import { sha256 } from '@noble/hashes/sha256'

/** Message the user signs in MetaMask. NEVER change this — different message = lost data. */
export const SIGN_MESSAGE = 'Nook Key Derivation v1'

export interface NookSigner {
  /** Compressed secp256k1 public key (33 bytes) derived from signingKey */
  getPublicKey(): Uint8Array

  /** Ethereum-style address derived from signingKey */
  getAddress(): string

  /** 32-byte private key for feed signing (bee-js signer) */
  getSigningKey(): Uint8Array

  /** 32-byte key for AES-GCM file/mail encryption */
  getEncryptionKey(): Uint8Array

  /** ECDH shared secret with another user's public key (for mail encryption) */
  deriveSharedSecret(theirPublicKey: Uint8Array): Uint8Array
}

/**
 * Create a NookSigner from a raw wallet signature.
 *
 * Derivation:
 *   masterSeed = keccak256(signature)
 *   signingKey = HMAC-SHA256(masterSeed, "nook:signing")
 *   encryptionKey = HMAC-SHA256(masterSeed, "nook:encryption")
 */
export function createWalletSigner(signatureHex: string): NookSigner {
  const sigBytes = hexToBytes(signatureHex)
  const masterSeed = keccak256(sigBytes)

  const signingKey = hmac(sha256, masterSeed, new TextEncoder().encode('nook:signing'))
  const encryptionKey = hmac(sha256, masterSeed, new TextEncoder().encode('nook:encryption'))

  const publicKey = secp256k1.getPublicKey(signingKey, true)

  const uncompressedPub = secp256k1.getPublicKey(signingKey, false)
  const addressBytes = keccak256(uncompressedPub.slice(1))
  const address = '0x' + bytesToHex(addressBytes.slice(-20))

  return {
    getPublicKey: () => publicKey,
    getAddress: () => address,
    getSigningKey: () => signingKey,
    getEncryptionKey: () => encryptionKey,
    deriveSharedSecret: (theirPublicKey: Uint8Array) => {
      const shared = secp256k1.getSharedSecret(signingKey, theirPublicKey)

      return keccak256(shared.slice(1))
    },
  }
}

/** Verify a wallet produces deterministic signatures by signing twice and comparing. */
export async function checkDeterministic(signFn: (message: string) => Promise<string>): Promise<boolean> {
  const sig1 = await signFn(SIGN_MESSAGE)
  const sig2 = await signFn(SIGN_MESSAGE)

  return sig1 === sig2
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex

  return new Uint8Array(clean.match(/.{2}/g)!.map(byte => parseInt(byte, 16)))
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
}
