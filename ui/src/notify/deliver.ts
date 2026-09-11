import type { Bee } from '@ethersphere/bee-js'

import type { NookSigner } from '../crypto/signer'
import { waitForBeeReady } from './bee-ready'
import { appendOutboxMessage, loadThreads, setMessageStatusByOutboxId } from './messages'
import {
  enqueueOutboxEntry,
  loadOutbox,
  type OutboxEntry,
  recordOutboxAttempt,
  removeOutboxEntry,
  resetOutboxAttempts,
} from './outbox'
import { sendMailboxMessage } from './send-message'
import { enqueueSend } from './send-queue'
import { loadContacts } from './storage'
import { type NookContact, toLibraryContact } from './types'

/**
 * Delivery engine for the persistent outbox (#117).
 *
 * One path for every mailbox sender (chat, drive-share, invite-ack):
 *
 *   queueAndDeliver() — persist the entry + 'sending' bubble FIRST, then
 *   attempt delivery through the per-recipient send queue. Success removes
 *   the entry and flips the bubble to 'sent'; failure records the attempt
 *   and, past FAILED_AFTER_ATTEMPTS, flips the bubble to 'failed' (the entry
 *   stays — the drain keeps retrying and "tap to retry" resets the counter).
 *
 *   drainOutbox() — runs from Layout on startup/node-ready/interval: delivers
 *   whatever previous sessions left behind, oldest first, and reconciles
 *   bubbles stuck on 'sending' whose entry is gone (gone = delivered).
 *
 * In-flight entries are tracked in a module Set so a drain tick can never
 * double-send an entry that queueAndDeliver (or a previous tick) is already
 * pushing — a duplicate would land on a second feed index and show twice for
 * the recipient.
 */

/** Consecutive failures before the bubble is marked failed (delivery still retries). */
export const FAILED_AFTER_ATTEMPTS = 3

const inFlight = new Set<string>()

export interface OutboxPayload {
  kind: OutboxEntry['kind']
  body: string
  subject?: string
  driveShare?: OutboxEntry['driveShare']
}

export interface QueueResult {
  entry: OutboxEntry
  /** Resolves true when the first delivery attempt succeeded, false when it
   *  failed (the entry stays queued and the drain will retry). */
  firstAttempt: Promise<boolean>
}

export function queueAndDeliver(
  bee: Bee,
  signer: NookSigner,
  stampId: string,
  contact: NookContact,
  payload: OutboxPayload,
): QueueResult {
  // Persist the intent BEFORE any async/network work — this ordering is the
  // whole point: once the bubble is visible, the send survives a quit.
  const entry = enqueueOutboxEntry({
    id: crypto.randomUUID(),
    recipientId: contact.id.toLowerCase(),
    ts: Date.now(),
    kind: payload.kind,
    body: payload.body,
    subject: payload.subject,
    driveShare: payload.driveShare,
  })

  appendOutboxMessage(loadThreads(), entry)

  return { entry, firstAttempt: attemptDelivery(bee, signer, stampId, entry, contact) }
}

async function attemptDelivery(
  bee: Bee,
  signer: NookSigner,
  stampId: string,
  entry: OutboxEntry,
  contact: NookContact,
): Promise<boolean> {
  if (inFlight.has(entry.id)) return false
  inFlight.add(entry.id)
  try {
    await enqueueSend(entry.recipientId, async () => {
      // Don't send during warmup — a send before the node can push never
      // propagates to the recipient (the receipt-less window).
      if (!(await waitForBeeReady())) throw new Error('Node not ready yet')

      return sendMailboxMessage(bee, signer.getSigningKey(), stampId, signer.getAddress(), toLibraryContact(contact), {
        subject: entry.subject ?? '',
        body: entry.body,
        ...(entry.kind === 'drive-share' && entry.driveShare
          ? {
              type: 'drive-share' as const,
              driveShareLink: entry.driveShare.driveShareLink,
              driveName: entry.driveShare.driveName,
              fileCount: entry.driveShare.fileCount,
            }
          : {}),
      })
    })
    // Network write confirmed — only now does the entry leave the outbox.
    removeOutboxEntry(entry.id)
    setMessageStatusByOutboxId(loadThreads(), entry.recipientId, entry.id, 'sent')

    return true
  } catch (err) {
    const attempts = recordOutboxAttempt(entry.id, String((err as Error)?.message ?? err))

    if (attempts >= FAILED_AFTER_ATTEMPTS) {
      setMessageStatusByOutboxId(loadThreads(), entry.recipientId, entry.id, 'failed')
    }

    return false
  } finally {
    inFlight.delete(entry.id)
  }
}

let draining = false

/**
 * Deliver everything the outbox holds, oldest first. Sequential on purpose:
 * per-recipient order is sacred (feed indexes), and cross-recipient fairness
 * doesn't matter at these volumes.
 */
export async function drainOutbox(bee: Bee, signer: NookSigner, stampId: string): Promise<void> {
  if (draining) return
  draining = true
  try {
    const entries = loadOutbox().sort((a, b) => a.ts - b.ts)
    const contacts = loadContacts()

    for (const entry of entries) {
      if (inFlight.has(entry.id)) continue
      const contact = contacts.find(c => c.id.toLowerCase() === entry.recipientId)

      if (!contact) {
        // Recipient no longer in contacts — the send can never complete.
        removeOutboxEntry(entry.id)
        setMessageStatusByOutboxId(loadThreads(), entry.recipientId, entry.id, 'failed')
        continue
      }
      await attemptDelivery(bee, signer, stampId, entry, contact)
    }

    // Reconcile: a bubble still 'sending' whose entry is gone means the entry
    // completed but the app died between the outbox removal and the status
    // write (or the store was reset). Missing entry = it left the outbox the
    // only way entries leave: delivered.
    const remaining = new Set(loadOutbox().map(e => e.id))
    let threads = loadThreads()

    for (const [counterparty, msgs] of Object.entries(threads)) {
      for (const m of msgs) {
        if (m.status === 'sending' && m.outboxId && !remaining.has(m.outboxId) && !inFlight.has(m.outboxId)) {
          threads = setMessageStatusByOutboxId(threads, counterparty, m.outboxId, 'sent')
        }
      }
    }
  } finally {
    draining = false
  }
}

/** User-initiated retry from a failed bubble: reset the counter and go again. */
export function retryOutboxEntry(bee: Bee, signer: NookSigner, stampId: string, outboxId: string): void {
  const entry = resetOutboxAttempts(outboxId)

  if (!entry) return
  const contact = loadContacts().find(c => c.id.toLowerCase() === entry.recipientId)

  if (!contact) return
  setMessageStatusByOutboxId(loadThreads(), entry.recipientId, entry.id, 'sending')
  void attemptDelivery(bee, signer, stampId, entry, contact)
}
