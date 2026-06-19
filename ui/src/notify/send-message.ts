/**
 * Deterministic mailbox send.
 *
 * The append-only swarm-notify mailbox writes each message to its own immutable
 * feed index and returns that index. This wrapper threads a PERSISTED
 * per-recipient cursor through `mailbox.send`:
 *
 *   - reads the recipient's next-index cursor and passes it as `nextIndex`
 *   - advances the cursor past the index the send actually wrote
 *
 * Passing the cursor means a send never relies on a network read-latest to find
 * its slot — which is exactly the unreliable operation right after node warmup,
 * and the source of the old overwrite/loss bug. With the cursor, every send is
 * O(1) and race-free by construction.
 *
 * Callers still own per-recipient serialization (`enqueueSend`) and the node
 * readiness gate (`waitForBeeReady`); this is purely the cursor + send step, so
 * every sender (chat, drive-share, invite ack) writes through one place.
 */
import type { Bee } from '@ethersphere/bee-js'
import { mailbox } from '@swarm-notify/sdk'
import type { Contact as LibraryContact, Message } from '@swarm-notify/sdk'

import { advanceSendCursor, getSendCursor } from './messages'

export async function sendMailboxMessage(
  bee: Bee,
  signingKey: Uint8Array,
  stamp: string,
  myAddr: string,
  recipient: LibraryContact,
  message: Omit<Message, 'v' | 'ts' | 'sender'>,
): Promise<number> {
  const cursor = getSendCursor(recipient.ethAddress)
  const index = await mailbox.send(bee, signingKey, stamp, signingKey, myAddr, recipient, message, cursor)

  advanceSendCursor(recipient.ethAddress, index)

  return index
}
