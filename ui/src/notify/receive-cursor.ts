/**
 * Per-contact mailbox READ cursors (R3b-2): how far this browser has read a
 * feed, so each poll resumes from `next` and re-reads only slots still worth
 * trying, instead of re-walking every full history each tick.
 *
 * Two feeds per contact: theirs to me (received) and mine to them (sent, read
 * back so messages I sent from another browser show here too, #191).
 *
 * Retried, each up to MAX_HOLE_TRIES so a permanent one costs a bounded number
 * of reads, never one per poll forever:
 * - holes: the slot exists but its payload couldn't be read (still
 *   propagating, or stranded by pre-0.5.2 deferred uploads);
 * - gaps: the walk hopped over a missing slot — usually never written, but a
 *   node that is still warming up reports existing slots missing for a while.
 *
 * Also the EXPECTED read position of their feed: how far any of my browsers
 * had read it (kept in the app folder, #192). A new browser knows from it that
 * their messages exist before it has found them, instead of guessing from an
 * empty read — on a slow node "not found yet" looks exactly like "never sent".
 *
 * Namespaced per identity like the threads they feed.
 */
import { nsKey } from './active-identity'
import { contactDataChanged } from './backup-signal'

const RECEIVED_KEY = 'nook-mailbox-read-cursors-v1'
const SENT_KEY = 'nook-mailbox-sent-cursors-v1'
const EXPECTED_KEY = 'nook-mailbox-expected-v1'

/** ~10 minutes of 30 s polls. */
export const MAX_HOLE_TRIES = 20

/**
 * Reads in a row that stopped at the same slot before it is moved to the
 * retry list and the cursor goes past it. A slot the node can't fetch is
 * usually temporary, but one that never reads (a damaged slot) must not hide
 * every later message for good.
 */
export const STALL_LIMIT = 5

interface ReadCursor {
  /** First feed index not yet walked */
  next: number
  /** Slot index still to retry (hole or gap) → times tried so far */
  holes: Record<string, number>
  /** Reads in a row that stopped early at `next` */
  stalls?: number
}

type CursorMap = Record<string, ReadCursor>

/** What one read returned — the fields of the SDK's MailboxReadResult the cursor needs. */
export interface ReadOutcome {
  nextIndex: number
  holes: number[]
  gaps?: number[]
  indexes?: number[]
  /** False when the read stopped at a slot the node couldn't fetch (SDK) */
  complete?: boolean
}

function load<T>(key: string): T | Record<string, never> {
  try {
    return JSON.parse(localStorage.getItem(nsKey(key)) ?? '{}') as T
  } catch {
    return {}
  }
}

function save(key: string, value: unknown): void {
  try {
    localStorage.setItem(nsKey(key), JSON.stringify(value))
  } catch {
    // quota / private mode — the next poll re-reads from the old cursor
  }
}

function cursorOf(key: string, contactId: string): ReadCursor | undefined {
  return (load<CursorMap>(key) as CursorMap)[contactId.toLowerCase()]
}

function getCursor(key: string, contactId: string): { fromIndex: number; retryIndices: number[] } {
  const c = cursorOf(key, contactId)

  return { fromIndex: c?.next ?? 0, retryIndices: c ? Object.keys(c.holes).map(Number) : [] }
}

/**
 * Persist the outcome of a read: the new position (never backwards), and what
 * to retry. A slot retried this time and still not delivered stays on the
 * list (the SDK drops a retried slot that reads as missing) until its tries
 * run out. Returns whether the position moved.
 */
function record(key: string, contactId: string, result: ReadOutcome): boolean {
  const map = load<CursorMap>(key) as CursorMap
  const id = contactId.toLowerCase()
  const previous = map[id]
  const tried = previous?.holes ?? {}
  const delivered = new Set(result.indexes ?? [])
  const retry = new Set<number>([
    ...result.holes,
    ...(result.gaps ?? []),
    ...Object.keys(tried)
      .map(Number)
      .filter(i => !delivered.has(i)),
  ])
  const holes: Record<string, number> = {}

  for (const i of retry) {
    const tries = (tried[String(i)] ?? 0) + 1

    if (tries < MAX_HOLE_TRIES) holes[String(i)] = tries
  }

  let next = Math.max(result.nextIndex, previous?.next ?? 0)
  const stuck = result.complete === false && next === (previous?.next ?? 0)
  let stalls = stuck ? (previous?.stalls ?? 0) + 1 : 0

  // Stopped at the same slot STALL_LIMIT times: retry it later, read on past it.
  if (stalls >= STALL_LIMIT) {
    holes[String(next)] = 1
    next += 1
    stalls = 0
  }

  map[id] = stalls > 0 ? { next, holes, stalls } : { next, holes }
  save(key, map)

  return next !== (previous?.next ?? 0)
}

/** Where to resume reading their mailbox (0 + no retries for a new contact). */
export function getReadCursor(contactId: string): { fromIndex: number; retryIndices: number[] } {
  return getCursor(RECEIVED_KEY, contactId)
}

/** True once their mailbox has been read at least once in this browser. */
export function hasReadCursor(contactId: string): boolean {
  return cursorOf(RECEIVED_KEY, contactId) !== undefined
}

/** Their slots this browser is still retrying (holes or gaps). */
export function hasRetries(contactId: string): boolean {
  return Object.keys(cursorOf(RECEIVED_KEY, contactId)?.holes ?? {}).length > 0
}

export function recordRead(contactId: string, result: ReadOutcome): void {
  // A new position is worth keeping in the app folder (expected position, #192).
  if (record(RECEIVED_KEY, contactId, result)) contactDataChanged()
}

/** Where to resume reading my own feed to them; undefined before the first read in this browser. */
export function getSentCursor(contactId: string): { fromIndex: number; retryIndices: number[] } | undefined {
  return cursorOf(SENT_KEY, contactId) ? getCursor(SENT_KEY, contactId) : undefined
}

export function recordSentRead(contactId: string, result: ReadOutcome): void {
  record(SENT_KEY, contactId, result)
}

/** How far any of my browsers had read their feed (from the app folder), per contact. */
export function loadExpected(): Record<string, number> {
  return load<Record<string, number>>(EXPECTED_KEY) as Record<string, number>
}

/** Raise expected positions (never lower them), e.g. from the app-folder file. */
export function raiseExpected(values: Record<string, number>): void {
  const map = loadExpected()
  let changed = false

  for (const [contactId, next] of Object.entries(values)) {
    const id = contactId.toLowerCase()

    if (Number.isInteger(next) && next > (map[id] ?? 0)) {
      map[id] = next
      changed = true
    }
  }

  if (changed) save(EXPECTED_KEY, map)
}

/** How far their feed must be read before this browser has everything any of mine had seen. */
export function expectedPosition(contactId: string): number {
  const id = contactId.toLowerCase()

  return Math.max(loadExpected()[id] ?? 0, cursorOf(RECEIVED_KEY, id)?.next ?? 0)
}

/** Their read positions to keep in the app folder: the higher of expected and this browser's own. */
export function positionsToKeep(): Record<string, number> {
  const out: Record<string, number> = { ...loadExpected() }

  for (const [id, c] of Object.entries(load<CursorMap>(RECEIVED_KEY) as CursorMap)) {
    if (c.next > (out[id] ?? 0)) out[id] = c.next
  }

  return out
}

/** How far this browser has actually read their feed. */
export function readPosition(contactId: string): number {
  return cursorOf(RECEIVED_KEY, contactId)?.next ?? 0
}
