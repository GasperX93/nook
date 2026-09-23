/**
 * Per-contact mailbox READ cursor (R3b-2). The inbox poller used to re-walk
 * every contact's full history each tick, ending every walk with a burst of
 * look-ahead probes (404s on the node). With the SDK's readMailbox the poller
 * resumes from `next` and re-reads only payload holes still worth trying.
 *
 * A hole is a slot whose payload couldn't be read — usually a just-sent
 * message still propagating. Each is retried on later polls and dropped after
 * MAX_HOLE_TRIES, so a permanent hole (a payload stranded by pre-0.5.2
 * deferred uploads) costs a bounded number of reads, never one per poll forever.
 *
 * Namespaced per identity like the threads it feeds.
 */
import { nsKey } from './active-identity'

const KEY = 'nook-mailbox-read-cursors-v1'

/** ~10 minutes of 30 s polls. */
export const MAX_HOLE_TRIES = 20

interface ReadCursor {
  /** First feed index not yet walked */
  next: number
  /** Unreadable slot index → times tried so far */
  holes: Record<string, number>
}

type CursorMap = Record<string, ReadCursor>

function loadAll(): CursorMap {
  try {
    return JSON.parse(localStorage.getItem(nsKey(KEY)) ?? '{}') as CursorMap
  } catch {
    return {}
  }
}

function saveAll(map: CursorMap): void {
  try {
    localStorage.setItem(nsKey(KEY), JSON.stringify(map))
  } catch {
    // quota / private mode — the next poll re-reads from the old cursor
  }
}

/** Where to resume reading this contact's mailbox (0 + no retries for a new contact). */
export function getReadCursor(contactId: string): { fromIndex: number; retryIndices: number[] } {
  const c = loadAll()[contactId.toLowerCase()]

  return { fromIndex: c?.next ?? 0, retryIndices: c ? Object.keys(c.holes).map(Number) : [] }
}

/** Persist the outcome of a read: new cursor, and holes with their retry counts. */
export function recordRead(contactId: string, result: { nextIndex: number; holes: number[] }): void {
  const map = loadAll()
  const key = contactId.toLowerCase()
  const previous = map[key]?.holes ?? {}
  const holes: Record<string, number> = {}

  for (const i of result.holes) {
    const tries = (previous[String(i)] ?? 0) + 1

    if (tries < MAX_HOLE_TRIES) holes[String(i)] = tries
  }

  map[key] = { next: Math.max(result.nextIndex, map[key]?.next ?? 0), holes }
  saveAll(map)
}
