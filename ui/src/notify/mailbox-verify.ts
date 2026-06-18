/**
 * Read-back verification for sent mailbox messages.
 *
 * mailbox.send writes the WHOLE message array to one feed slot (read-modify-
 * write). A just-written chunk isn't always immediately retrievable, so a
 * following send can read the stale array and overwrite — losing messages
 * (observed: rapid sends collapse to only the last one delivered).
 *
 * `confirmSentGrew` reads our OWN sender→recipient feed back and waits until
 * the array has grown past the pre-send length — i.e. our message actually
 * landed and is retrievable. Gating the next send on this (in the send queue)
 * means each read-modify-write sees the previous message, so nothing clobbers.
 * It also gives an honest "sent ✓" signal.
 *
 * Uses the SDK's exported feedTopic + crypto (no SDK change needed). Mirrors
 * the SDK's own readFeedMessages payload format (nonce[0..12] | ciphertext).
 */
import { Bee } from '@ethersphere/bee-js'
import { crypto, mailbox } from '@swarm-notify/sdk'

import { NookSigner } from '../crypto/signer'
import { hexToBytes } from '../lib/hex'

/** One entry in a mailbox feed array (the fields we care about). */
export interface SentMsg {
  body?: string
  sender?: string
  ts?: number
}

/** Read the current message array on MY→recipient feed. [] if missing/unreadable. */
export async function readSentArray(
  bee: Bee,
  signer: NookSigner,
  recipientEthAddr: string,
  recipientWalletPubKeyHex: string,
): Promise<SentMsg[]> {
  try {
    const topic = mailbox.feedTopic(signer.getAddress(), recipientEthAddr)
    const sharedSecret = crypto.deriveSharedSecret(signer.getSigningKey(), hexToBytes(recipientWalletPubKeyHex))
    const reader = bee.makeFeedReader(topic, signer.getAddress())
    const result = await reader.downloadPayload()
    const enc = result.payload.toUint8Array()
    const decrypted = await crypto.decrypt({ ciphertext: enc.slice(12), nonce: enc.slice(0, 12) }, sharedSecret)
    const arr = JSON.parse(new TextDecoder().decode(decrypted))

    return Array.isArray(arr) ? (arr as SentMsg[]) : []
  } catch {
    return []
  }
}

/**
 * Poll the sent feed until it has grown past `beforeLen` (our message landed +
 * is retrievable), or timeout. Returns true if confirmed.
 */
export async function confirmSentGrew(
  bee: Bee,
  signer: NookSigner,
  recipientEthAddr: string,
  recipientWalletPubKeyHex: string,
  beforeLen: number,
  opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<boolean> {
  const timeoutMs = opts.timeoutMs ?? 25_000
  const intervalMs = opts.intervalMs ?? 1_500
  const deadline = Date.now() + timeoutMs

  for (;;) {
    const arr = await readSentArray(bee, signer, recipientEthAddr, recipientWalletPubKeyHex)

    if (arr.length > beforeLen) return true

    if (Date.now() >= deadline) return false
    await new Promise(resolve => setTimeout(resolve, intervalMs))
  }
}
