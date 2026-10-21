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
 * Reads in a row that stopped at the same slot before the poller checks
 * whether anything exists after it. Only if something does is the slot moved
 * to the retry list and reading goes on past it — a slot that never reads (a
 * damaged one) must not hide every later message, but the end of a feed must
 * never be skipped (while Bee is down every read stops there).
 */
export const STALL_LIMIT = 5

interface ReadCursor {
  /** First feed index not yet walked */
  next: number
  /** Slot index still to retry (hole or gap) → times tried so far */
  holes: Record<string, number>
  /** Reads in a row that stopped early at `next` */
  stalls?: number
  /**
   * Slots read past after they kept stopping reads, proven not to be the end
   * → times tried. Retried like holes, but kept apart: they say nothing about
   * whether the contact has written to me.
   */
  skipped?: Record<string, number>
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
  /** A stuck slot to read past — only when a read after it found something */
  skip?: number
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
  const retry = new Set([...Object.keys(c?.holes ?? {}), ...Object.keys(c?.skipped ?? {})].map(Number))

  return { fromIndex: c?.next ?? 0, retryIndices: [...retry] }
}

/**
 * Keep the slots still worth retrying: not delivered this time, tries left.
 * Only a slot retried in this read (or new) counts a try; `retried` undefined
 * means every known slot was retried.
 */
function stillToRetry(
  tried: Record<string, number>,
  delivered: Set<number>,
  add: number[],
  retried: Set<number> | undefined,
): Record<string, number> {
  const out: Record<string, number> = {}

  for (const i of new Set([...add, ...Object.keys(tried).map(Number)])) {
    if (delivered.has(i) && !add.includes(i)) continue
    const known = tried[String(i)]
    const tries = known === undefined || !retried || retried.has(i) ? (known ?? 0) + 1 : known

    if (tries < MAX_HOLE_TRIES) out[String(i)] = tries
  }

  return out
}

/**
 * Persist the outcome of a read: the new position (never backwards), and what
 * to retry. A slot retried this time and still not delivered stays on the
 * list (the SDK drops a retried slot that reads as missing) until its tries
 * run out. Returns whether the position moved.
 */
function record(key: string, contactId: string, result: ReadOutcome, retriedList?: number[]): boolean {
  const map = load<CursorMap>(key) as CursorMap
  const id = contactId.toLowerCase()
  const previous = map[id]
  const delivered = new Set(result.indexes ?? [])
  const retried = retriedList ? new Set(retriedList) : undefined
  const holes = stillToRetry(previous?.holes ?? {}, delivered, [...result.holes, ...(result.gaps ?? [])], retried)
  const skipped = stillToRetry(
    previous?.skipped ?? {},
    delivered,
    result.skip === undefined ? [] : [result.skip],
    retried,
  )
  const next = Math.max(result.nextIndex, previous?.next ?? 0)
  const stuck = result.complete === false && next === (previous?.next ?? 0)
  const stalls = stuck ? (previous?.stalls ?? 0) + 1 : 0
  const cursor: ReadCursor = { next, holes }

  if (stalls > 0) cursor.stalls = stalls

  if (Object.keys(skipped).length > 0) cursor.skipped = skipped
  map[id] = cursor
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

/** `retried`: the retryIndices this read was given (only those count a try). */
export function recordRead(contactId: string, result: ReadOutcome, retried?: number[]): void {
  // A new position is worth keeping in the app folder (expected position, #192).
  if (record(RECEIVED_KEY, contactId, result, retried)) contactDataChanged()
}

/** Where to resume reading my own feed to them; undefined before the first read in this browser. */
export function getSentCursor(contactId: string): { fromIndex: number; retryIndices: number[] } | undefined {
  return cursorOf(SENT_KEY, contactId) ? getCursor(SENT_KEY, contactId) : undefined
}

export function recordSentRead(contactId: string, result: ReadOutcome, retried?: number[]): void {
  record(SENT_KEY, contactId, result, retried)
}

/** Nothing after a stuck slot: start the stall count over, touching nothing else. */
export function clearStalls(contactId: string, direction: 'sent' | 'received'): void {
  const key = direction === 'sent' ? SENT_KEY : RECEIVED_KEY
  const map = load<CursorMap>(key) as CursorMap
  const id = contactId.toLowerCase()

  if (!map[id]?.stalls) return
  delete map[id].stalls
  save(key, map)
}

/** The slot their feed keeps stopping at, once it has STALL_LIMIT times in a row. */
export function theirStalledAt(contactId: string): number | undefined {
  const c = cursorOf(RECEIVED_KEY, contactId)

  return c && (c.stalls ?? 0) >= STALL_LIMIT ? c.next : undefined
}

/** The slot my own feed to them keeps stopping at, once it has STALL_LIMIT times in a row. */
export function sentStalledAt(contactId: string): number | undefined {
  const c = cursorOf(SENT_KEY, contactId)

  return c && (c.stalls ?? 0) >= STALL_LIMIT ? c.next : undefined
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
