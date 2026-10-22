/**
 * Classic drive data lives in the app (src/drive-data.ts), the same in every
 * browser on this computer. Before, file lists, folders, encrypted-drive
 * settings and Shared with me were only in the browser's localStorage, so
 * another browser or a private window showed every drive with 0 files.
 *
 * The browser keeps localStorage as a synchronous copy (the hooks and the
 * code outside React read it, and a downgrade to 0.7.2 still finds
 * everything): every change is written there first and sent to the app as
 * an op; the app's answer replaces the copy. Ops are kept in localStorage
 * until the app has them, so a change made while the app can't be reached
 * (or right before the tab closes) is sent later instead of lost.
 *
 * On load, after a focus and every 30 s the copy is refreshed from the app;
 * whatever this browser holds and the app doesn't (data from before this
 * version, or from 0.7.2 after a downgrade) is imported — the app never lets
 * an import overwrite or bring back a deleted item.
 */
import { create } from 'zustand'

import { serverApi } from '../api/server'

// ─── The app's shapes (src/drive-data.ts) ────────────────────────────────────

type Item = { id: string } & Record<string, unknown>

export interface DriveStore {
  version: 1
  rev: number
  records: Item[]
  folders: Item[]
  metadata: Record<string, Record<string, unknown>>
  shared: Item[]
  deleted: { records: Record<string, number>; folders: Record<string, number>; shared: Record<string, number> }
}

export type DriveOp =
  | { kind: 'record' | 'folder' | 'shared'; op: 'put'; value: Item }
  | { kind: 'record' | 'folder' | 'shared'; op: 'patch'; id: string; changes: Record<string, unknown> }
  | { kind: 'record' | 'folder' | 'shared'; op: 'delete'; id: string }
  | { kind: 'metadata'; op: 'patch'; batch: string; changes: Record<string, unknown> }
  | { kind: 'metadata'; op: 'delete'; batch: string }

export interface DriveImport {
  records?: unknown[]
  folders?: unknown[]
  metadata?: Record<string, unknown>
  shared?: unknown[]
}

// ─── The localStorage copy ───────────────────────────────────────────────────

export const DRIVE_STORAGE = {
  records: 'swarm-drive',
  folders: 'nook-folders',
  metadata: 'nook-drive-metadata',
  shared: 'nook-shared-drives',
} as const

/** Mounted hooks reload their state on these. */
export const DRIVE_EVENTS = {
  records: 'nook:records-changed',
  folders: 'nook:records-changed',
  metadata: 'nook:drive-metadata-changed',
  shared: 'nook:shared-drives-changed',
} as const

const PENDING_KEY = 'nook-drive-ops-pending'
/** A drive's ACT state, kept by the app once it has a head (src/act-head.ts). */
const ACT_FIELDS = ['actHistoryRef', 'granteeRef', 'granteeCount']
const REFRESH_MS = 30_000
const RETRY_MS = 5_000

type Part = keyof typeof DRIVE_STORAGE

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)

    return raw === null ? fallback : (JSON.parse(raw) as T)
  } catch {
    return fallback
  }
}

/** A patch carries null for "remove this field" — JSON has no undefined. */
export function toPatch(changes: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(changes)) out[key] = value === undefined ? null : value

  return out
}

function hexKey(value: unknown): string {
  return typeof value === 'string' ? value.toLowerCase().replace(/^0x/, '') : ''
}

/** Same as the app's: a shared drive is its feed (topic + owner), whatever its id in this browser. */
export function sharedKey(drive: Record<string, unknown>): string {
  const topic = hexKey(drive.feedTopic)
  const owner = hexKey(drive.feedOwner)

  return topic && owner ? `feed:${topic}:${owner}` : `id:${String(drive.id)}`
}

// ─── Status ──────────────────────────────────────────────────────────────────

interface DriveDataState {
  /** loading = not yet read from the app; offline = never reached it (the local copy is all there is). */
  status: 'loading' | 'ready' | 'offline'
}

export const useDriveDataStore = create<DriveDataState>(() => ({ status: 'loading' }))

// ─── Sending changes ─────────────────────────────────────────────────────────

let chain: Promise<unknown> = Promise.resolve()
let retryTimer: ReturnType<typeof setTimeout> | null = null
/**
 * The app's data replaces the local copy only after this browser's own data
 * was offered to it once: before that, the local copy may hold the only
 * record of files (data from before this version, or added in 0.7.2 after a
 * downgrade) and an early answer would erase them.
 */
let importedOnce = false

/** A batch of ops, kept until the app has it. The id lets tabs sharing the queue remove exactly what they sent. */
interface PendingBatch {
  id: string
  ops: DriveOp[]
}

/** One run at a time: flushes, refreshes and imports never interleave. */
async function serialized<T>(task: () => Promise<T>): Promise<T> {
  const run = chain.then(task, task)

  chain = run.catch(() => undefined)

  return run
}

function readPending(): PendingBatch[] {
  const pending = readJson<unknown>(PENDING_KEY, [])

  return Array.isArray(pending)
    ? pending.filter((b): b is PendingBatch => typeof b?.id === 'string' && Array.isArray(b?.ops))
    : []
}

function writePending(pending: PendingBatch[]): boolean {
  try {
    if (pending.length === 0) localStorage.removeItem(PENDING_KEY)
    else localStorage.setItem(PENDING_KEY, JSON.stringify(pending))

    return true
  } catch {
    return false
  }
}

/** Removes one sent batch by id — another tab may have sent or added batches meanwhile. */
function removePending(id: string): void {
  writePending(readPending().filter(b => b.id !== id))
}

/**
 * Send ops the hooks just applied to the local copy. Kept until the app
 * has them; sent in order. (Two tabs may both send a batch; every op is
 * safe to apply twice.)
 */
export function sendDriveOps(ops: DriveOp[]): void {
  if (ops.length === 0) return
  const batch: PendingBatch = { id: crypto.randomUUID(), ops }

  if (!writePending([...readPending(), batch])) {
    // Storage full: it can't be kept, so send it now, best effort.
    void serialized(async () => serverApi.changeDriveData(ops).catch(() => undefined))

    return
  }
  void serialized(flushPending)
}

/** Sends every kept batch in order; false when the app couldn't be reached (retried soon). */
async function flushPending(): Promise<boolean> {
  for (;;) {
    const [batch] = readPending()

    if (!batch) return true
    let store: DriveStore

    try {
      store = await serverApi.changeDriveData(batch.ops)
    } catch (error) {
      // A batch the app refuses (400) would block every later one forever: drop it.
      if (error instanceof Error && /invalid ops/i.test(error.message)) {
        removePending(batch.id)
        continue
      }
      scheduleRetry()

      return false
    }
    removePending(batch.id)

    if (readPending().length === 0) applyStore(store)
  }
}

function scheduleRetry(): void {
  if (retryTimer) return
  retryTimer = setTimeout(() => {
    retryTimer = null
    void serialized(flushPending)
  }, RETRY_MS)
}

// ─── Reading from the app ────────────────────────────────────────────────────

/** What this browser holds that the app doesn't — null when nothing. */
export function missingFromApp(store: DriveStore): DriveImport | null {
  const records = readJson<Item[]>(DRIVE_STORAGE.records, [])
  const folders = readJson<Item[]>(DRIVE_STORAGE.folders, [])
  const shared = readJson<Item[]>(DRIVE_STORAGE.shared, [])
  const metadata = readJson<Record<string, Record<string, unknown>>>(DRIVE_STORAGE.metadata, {})

  const recordIds = new Set(store.records.map(r => r.id))
  const folderIds = new Set(store.folders.map(f => f.id))
  const sharedKeys = new Set(store.shared.map(sharedKey))

  const out: Required<DriveImport> = {
    records: Array.isArray(records)
      ? records.filter(r => r?.id && !recordIds.has(r.id) && !(r.id in store.deleted.records))
      : [],
    folders: Array.isArray(folders)
      ? folders.filter(f => f?.id && !folderIds.has(f.id) && !(f.id in store.deleted.folders))
      : [],
    shared: Array.isArray(shared)
      ? shared.filter(d => d?.id && !sharedKeys.has(sharedKey(d)) && !(sharedKey(d) in store.deleted.shared))
      : [],
    metadata: {},
  }

  for (const [batch, local] of Object.entries(metadata && typeof metadata === 'object' ? metadata : {})) {
    if (!local || typeof local !== 'object') continue
    const have = store.metadata[batch]
    // The app keeps its own ACT state once it has a head; offering ours again would change nothing.
    const offered = Object.keys(local).filter(
      field => !(have?.actHistoryRef !== undefined && ACT_FIELDS.includes(field)) && local[field] !== null,
    )

    if (!have || offered.some(field => !(field in have))) out.metadata[batch] = local
  }

  const empty =
    out.records.length === 0 &&
    out.folders.length === 0 &&
    out.shared.length === 0 &&
    Object.keys(out.metadata).length === 0

  return empty ? null : out
}

/** Writes the app's data into the local copy (only what changed) and tells mounted hooks. */
function applyStore(store: DriveStore): void {
  // Not before this browser's data was offered to the app (importedOnce), and
  // not while a local change is still on its way — the next answer has it.
  if (!importedOnce || readPending().length > 0) return
  const parts: Record<Part, unknown> = {
    records: store.records,
    folders: store.folders,
    metadata: store.metadata,
    shared: store.shared,
  }
  const events = new Set<string>()

  for (const part of Object.keys(parts) as Part[]) {
    const next = JSON.stringify(parts[part])

    try {
      if (localStorage.getItem(DRIVE_STORAGE[part]) === next) continue
      localStorage.setItem(DRIVE_STORAGE[part], next)
    } catch {
      continue
    }
    events.add(DRIVE_EVENTS[part])
  }
  useDriveDataStore.setState({ status: 'ready' })
  events.forEach(name => window.dispatchEvent(new Event(name)))
}

/** Flush what's kept, read the app's data, import what only this browser has, refresh the copy. */
export async function refreshDriveData(): Promise<void> {
  await serialized(async () => {
    if (!(await flushPending())) {
      markOffline()

      return
    }

    try {
      let store = await serverApi.getDriveData()
      const missing = missingFromApp(store)

      if (missing) store = await serverApi.importDriveData(missing)
      importedOnce = true
      applyStore(store)
    } catch {
      markOffline()
    }
  })
}

function markOffline(): void {
  if (useDriveDataStore.getState().status === 'loading') useDriveDataStore.setState({ status: 'offline' })
}

/** Another tab changed the copy: reload this tab's hooks (nothing is written back). */
function onStorage(event: StorageEvent): void {
  for (const part of Object.keys(DRIVE_STORAGE) as Part[]) {
    if (event.key === DRIVE_STORAGE[part]) window.dispatchEvent(new Event(DRIVE_EVENTS[part]))
  }
}

/** Runs for the life of the dashboard (Layout). Returns the cleanup. */
export function startDriveData(): () => void {
  const refresh = () => void refreshDriveData()
  const onVisible = () => {
    if (document.visibilityState === 'visible') refresh()
  }

  refresh()
  const interval = setInterval(refresh, REFRESH_MS)

  window.addEventListener('focus', refresh)
  document.addEventListener('visibilitychange', onVisible)
  window.addEventListener('storage', onStorage)

  return () => {
    clearInterval(interval)
    window.removeEventListener('focus', refresh)
    document.removeEventListener('visibilitychange', onVisible)
    window.removeEventListener('storage', onStorage)
  }
}

/** Tests only. */
export function resetDriveDataForTests(): void {
  chain = Promise.resolve()
  importedOnce = false

  if (retryTimer) clearTimeout(retryTimer)
  retryTimer = null
  useDriveDataStore.setState({ status: 'loading' })
}
