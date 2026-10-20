/**
 * Publish the user's identity to their Swarm feed so others can resolve their
 * wallet + bee public keys by address (required before anyone can accept an
 * invite or add-back a drive share). One source of truth, shared by the
 * Identity tab and the inline "Publish & send" on the invite composer.
 */
import { Bee } from '@ethersphere/bee-js'
import { identity } from '@swarm-notify/sdk'

import { NookSigner } from '../crypto/signer'
import { bytesToHex } from '../lib/hex'
import { markIdentityPublished } from './storage'

export async function publishIdentity(
  bee: Bee,
  signer: NookSigner,
  stampId: string,
  beePublicKey: string,
): Promise<void> {
  await identity.publish(bee, signer.getSigningKey(), stampId, {
    walletPublicKey: bytesToHex(signer.getPublicKey()),
    beePublicKey,
    ethAddress: signer.getAddress(),
  })
  // Verify the feed is readable before claiming success.
  const readback = await identity.resolve(bee, signer.getAddress())

  if (!readback) throw new Error('Published but could not verify — try again')

  markIdentityPublished(signer.getAddress())
}

/** Same bound as the SDK's identity feed walk (MAX_IDENTITY_SLOTS). */
const MAX_IDENTITY_SLOTS = 32

/**
 * Store the published identity again with another batch — the same slots,
 * the same content, a new stamp. Bee keeps a chunk for as long as ANY of its
 * stamps lives (reserve Put stores a stamp from another batch alongside), so
 * the identity outlives a replaced reserve. The SDK's publish skips an
 * unchanged identity, so this writes the slots directly. Returns the number
 * of slots stored.
 */
export async function restampIdentity(bee: Bee, signer: NookSigner, stampId: string): Promise<number> {
  const address = signer.getAddress()
  const topic = identity.feedTopic(address)
  const reader = bee.feed.makeReader(topic, address)
  const writer = bee.feed.makeWriter(topic, signer.getSigningKey())
  let stored = 0

  for (let index = 0; index < MAX_IDENTITY_SLOTS; index++) {
    let payload: Uint8Array

    try {
      payload = (await reader.downloadPayload({ index })).payload.toUint8Array()
    } catch {
      break
    }
    await writer.uploadPayload(stampId, payload, { index, deferred: false })
    stored++
  }

  return stored
}
