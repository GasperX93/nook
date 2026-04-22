import type { Message as SdkMessage } from '@swarm-notify/sdk'

/**
 * Local persistence for message threads.
 *
 * The swarm-notify SDK reads received messages from each contact's outgoing
 * feed (contact→me). It does not store sent messages anywhere readable, so we
 * keep our own copy in localStorage. On every inbox poll we refresh the
 * `received` slice per contact; `sent` messages stay local until the SDK gains
 * a "read my own outbox" call.
 *
 * Per-origin like `nook-contacts-v2`. Tracked at #47.
 */

export interface StoredMessage {
  /** Stable id — `${ts}-${direction}-${shortBody}` for dedupe */
  id: string
  /** Counterparty (the OTHER party) — lowercased ETH address */
  counterparty: string
  /** Unix ms */
  ts: number
  /** Plain text */
  body: string
  direction: 'sent' | 'received'
  /** Optional message kind. Default 'message'. 'drive-share' renders as a card. */
  kind?: 'message' | 'drive-share'
  /** Drive-share fields — only present when kind === 'drive-share' */
  driveShareLink?: string
  driveName?: string
  fileCount?: number
}

export interface DriveShareExtras {
  driveShareLink: string
  driveName: string
  fileCount: number
}

const MESSAGES_KEY = 'nook-messages-v1'
const READ_CURSOR_KEY = 'nook-messages-read-v1'

type ThreadMap = Record<string, StoredMessage[]>
type ReadCursorMap = Record<string, number>

function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)

    return raw ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}

export function loadThreads(): ThreadMap {
  return load<ThreadMap>(MESSAGES_KEY, {})
}

export function saveThreads(threads: ThreadMap): void {
  localStorage.setItem(MESSAGES_KEY, JSON.stringify(threads))
}

export function loadReadCursors(): ReadCursorMap {
  return load<ReadCursorMap>(READ_CURSOR_KEY, {})
}

export function saveReadCursors(cursors: ReadCursorMap): void {
  localStorage.setItem(READ_CURSOR_KEY, JSON.stringify(cursors))
}

function makeId(ts: number, direction: StoredMessage['direction'], body: string): string {
  return `${ts}-${direction}-${body.slice(0, 32)}`
}

/** Append a sent text message to a thread. */
export function appendSent(threads: ThreadMap, counterparty: string, body: string, ts = Date.now()): ThreadMap {
  const key = counterparty.toLowerCase()
  const msg: StoredMessage = {
    id: makeId(ts, 'sent', body),
    counterparty: key,
    ts,
    body,
    direction: 'sent',
    kind: 'message',
  }
  const updated: ThreadMap = { ...threads, [key]: [...(threads[key] ?? []), msg] }

  saveThreads(updated)

  return updated
}

/** Append a sent drive-share message to a thread. */
export function appendSentDriveShare(
  threads: ThreadMap,
  counterparty: string,
  extras: DriveShareExtras,
  ts = Date.now(),
): ThreadMap {
  const key = counterparty.toLowerCase()
  // Keep `body` as plain text so older renderers (and the conversation preview)
  // still show something readable if the kind tag gets lost.
  const body = `Shared "${extras.driveName}" (${extras.fileCount} file${extras.fileCount === 1 ? '' : 's'})`
  const msg: StoredMessage = {
    id: makeId(ts, 'sent', body),
    counterparty: key,
    ts,
    body,
    direction: 'sent',
    kind: 'drive-share',
    driveShareLink: extras.driveShareLink,
    driveName: extras.driveName,
    fileCount: extras.fileCount,
  }
  const updated: ThreadMap = { ...threads, [key]: [...(threads[key] ?? []), msg] }

  saveThreads(updated)

  return updated
}

/**
 * Replace the `received` slice for a counterparty with fresh data from the SDK.
 * Sent messages are preserved.
 */
export function mergeReceived(threads: ThreadMap, counterparty: string, received: SdkMessage[]): ThreadMap {
  const key = counterparty.toLowerCase()
  const existingSent = (threads[key] ?? []).filter(m => m.direction === 'sent')
  const incoming: StoredMessage[] = received.map(m => ({
    id: makeId(m.ts, 'received', m.body),
    counterparty: key,
    ts: m.ts,
    body: m.body,
    direction: 'received',
    kind: m.type === 'drive-share' ? 'drive-share' : 'message',
    driveShareLink: m.driveShareLink,
    driveName: m.driveName,
    fileCount: m.fileCount,
  }))
  const merged = [...existingSent, ...incoming].sort((a, b) => a.ts - b.ts)
  const updated: ThreadMap = { ...threads, [key]: merged }

  saveThreads(updated)

  return updated
}

/** Count unread received messages for a counterparty. */
export function unreadCount(thread: StoredMessage[] | undefined, cursor: number | undefined): number {
  if (!thread) return 0
  const c = cursor ?? 0

  return thread.filter(m => m.direction === 'received' && m.ts > c).length
}

/** Mark a conversation read up to `ts` (defaults to now). */
export function markRead(cursors: ReadCursorMap, counterparty: string, ts = Date.now()): ReadCursorMap {
  const updated = { ...cursors, [counterparty.toLowerCase()]: ts }

  saveReadCursors(updated)

  return updated
}
