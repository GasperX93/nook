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
import { mailbox } from '@swarm-notify/sdk'

import { NookSigner } from '../crypto/signer'
import { appendSent, loadThreads } from './messages'
import { type NookContact, toLibraryContact } from './types'

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

  try {
    await mailbox.send(
      bee,
      signer.getSigningKey(),
      stampId,
      signer.getSigningKey(),
      signer.getAddress(),
      toLibraryContact(sender),
      { subject: '', body },
    )
    // Mirror it into our own thread so the conversation isn't empty.
    appendSent(loadThreads(), sender.id, body)
  } catch {
    // Best-effort — the contact is already added; the sender just won't flip to
    // "connected" until we send a real message.
  }
}
