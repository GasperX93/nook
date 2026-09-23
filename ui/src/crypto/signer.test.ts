import { describe, expect, it } from 'vitest'

import { bytesToHex } from '../lib/hex'
import { createSeedSigner, createSignerFromSecret, createWalletSigner, SWARM_ID_SECRET_PREFIX } from './signer'

// Any change to the derivation chain rotates every user's identity (new Nook
// address, unreadable mailboxes). The vector was cross-checked with an
// independent keccak256 → HMAC-SHA256 → secp256k1 computation (node crypto + ethers).
const SEED = '11'.repeat(32)
const SEED_ADDRESS = '0xf8e0dfea7d4b390f3e20a03ab67de9eb58601ca4'
const SEED_ENCRYPTION_KEY = 'a5e0fecbfacd87c832b39b41ddf69f14a8b0cc42d0377e89b849882a4252807f'

describe('createSeedSigner', () => {
  it('derives the pinned identity from a Swarm ID app secret', () => {
    const signer = createSeedSigner(SEED)

    expect(signer.getAddress()).toBe(SEED_ADDRESS)
    expect(bytesToHex(signer.getEncryptionKey())).toBe(SEED_ENCRYPTION_KEY)
  })

  it('is deterministic', () => {
    expect(createSeedSigner(SEED).getAddress()).toBe(createSeedSigner(SEED).getAddress())
  })
})

describe('createSignerFromSecret', () => {
  it('routes a prefixed secret to the seed signer', () => {
    expect(createSignerFromSecret(`${SWARM_ID_SECRET_PREFIX}${SEED}`).getAddress()).toBe(SEED_ADDRESS)
  })

  it('routes an unprefixed secret to the legacy wallet signer', () => {
    const signature = '0x' + '22'.repeat(65)

    expect(createSignerFromSecret(signature).getAddress()).toBe(createWalletSigner(signature).getAddress())
  })
})
