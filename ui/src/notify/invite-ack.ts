/**
 * Invitation acknowledgment.
 *
 * Accepting an invitation is a local-only action (it just adds the sender as a
 * contact), so the SENDER has no way to know it happened — their side stays on
 * "invitation sent — waiting" forever. Sending a brief mailbox message back on
 * accept gives the sender an inbound message, which flips their connection
 * state to "connected" (deriveConnectionState requires hasInbound).
 *
 * No on-chain cost: by the time we accept, both sides are mutual contacts, so
 * the sender's inbox poll reads our mailbox feed directly. Best-effort — a
 * failure here must never block the accept itself.
 */
import { Bee } from '@ethersphere/bee-js'

import { NookSigner } from '../crypto/signer'
import { queueAndDeliver } from './deliver'
import { type NookContact } from './types'

export async function sendInviteAck(
  bee: Bee,
  signer: NookSigner,
  stampId: string,
  sender: NookContact,
  myDisplayName: string,
): Promise<void> {
  if (!stampId) return
  const name = myDisplayName.trim() || 'They'
  const body = `${name} accepted your invitation`

  // Persistent outbox (#117): the ack + its thread bubble are stored before
  // any network work, and the Layout drain retries — so an ack sent right
  // before a quit still reaches the inviter (whose UI is stuck on "waiting"
  // until something inbound arrives).
  queueAndDeliver(bee, signer, stampId, sender, { kind: 'invite-ack', body })
}
