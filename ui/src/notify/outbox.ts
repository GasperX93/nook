import { nsKey } from './active-identity'
import type { DriveMessageKind, DriveShareExtras } from './messages'

/**
 * Persistent outbox (#117).
 *
 * The old send path appended the bubble optimistically and delivered from an
 * in-memory queue — quit the app inside that window and the message was
 * silently lost while the thread showed it as sent, forever.
 *
 * The outbox inverts the order: the send intent is persisted here (plus a
 * 'sending' bubble in the thread) BEFORE any network work. An entry is only
 * removed after `mailbox.send` has actually written to the network, and a
 * drain worker retries pending entries on startup, on node-ready, and
 * periodically — so a send that dies with the app is delivered the next time
 * Nook runs, and the bubble tells the truth the whole way.
 *
 * Per-identity localStorage, like threads and cursors (#47 applies here too).
 */

export interface OutboxEntry {
  /** Stable id — also links the thread bubble (StoredMessage.outboxId) */
  id: string
  /** Recipient — lowercased ETH address */
  recipientId: string
  /** Unix ms when the user hit send — bubble timestamp and drain order */
  ts: number
  kind: 'message' | DriveMessageKind | 'invite-ack'
  body: string
  subject?: string
  /** Present for the drive kinds */
  driveShare?: DriveShareExtras
  /** Completed delivery attempts that failed */
  attempts: number
  lastError?: string
}

const OUTBOX_KEY = 'nook-outbox-v1'

export function loadOutbox(): OutboxEntry[] {
  try {
    const raw = localStorage.getItem(nsKey(OUTBOX_KEY))

    if (!raw) return []
    const data = JSON.parse(raw) as OutboxEntry[]

    return Array.isArray(data) ? data : []
  } catch {
    // Corrupt JSON or storage error — treat as empty rather than crash. The
    // worst case is bubbles stuck on 'sending', which the drain reconciler
    // flips to 'sent' (missing entry means it left the outbox).
    return []
  }
}

function saveOutbox(entries: OutboxEntry[]): void {
  localStorage.setItem(nsKey(OUTBOX_KEY), JSON.stringify(entries))
}

/** Persist a new entry. MUST be called before any delivery attempt. */
export function enqueueOutboxEntry(entry: Omit<OutboxEntry, 'attempts'>): OutboxEntry {
  const full: OutboxEntry = { ...entry, recipientId: entry.recipientId.toLowerCase(), attempts: 0 }

  saveOutbox([...loadOutbox(), full])

  return full
}

/** Remove an entry — only after the network write succeeded (or is unsalvageable). */
export function removeOutboxEntry(id: string): void {
  saveOutbox(loadOutbox().filter(e => e.id !== id))
}

/** Record a failed attempt; returns the new attempt count (0 if entry vanished). */
export function recordOutboxAttempt(id: string, error: string): number {
  const entries = loadOutbox()
  const entry = entries.find(e => e.id === id)

  if (!entry) return 0
  entry.attempts += 1
  entry.lastError = error
  saveOutbox(entries)

  return entry.attempts
}

/** Reset the attempt counter — user-initiated "tap to retry". */
export function resetOutboxAttempts(id: string): OutboxEntry | undefined {
  const entries = loadOutbox()
  const entry = entries.find(e => e.id === id)

  if (!entry) return undefined
  entry.attempts = 0
  entry.lastError = undefined
  saveOutbox(entries)

  return entry
}
