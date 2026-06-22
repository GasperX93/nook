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
