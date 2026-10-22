import { copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'fs'

import { logger } from './logger'
import { getPath } from './path'

/**
 * Classic drive data in the app. The dashboard kept file lists, folders,
 * encrypted-drive settings and "Shared with me" in the browser's
 * localStorage, so another browser or a private window showed every drive
 * with 0 files — and, missing the encrypted flag, could upload unencrypted
 * into an encrypted drive. This one file in the data folder is the single
 * copy now; every browser reads and changes it through /drive-data.
 *
 * Node-level, not per identity: drives belong to the Bee node.
 *
 * Records, folders and shared drives are the dashboard's own types; the
 * server only needs their ids (and a shared drive's feed) and keeps the
 * rest as sent. A delete leaves a tombstone, so another browser's import
 * can't bring the item back.
 */

const FILE = 'drives.json'

type Item = { id: string } & Record<string, unknown>

export interface DriveStore {
  version: 1
  /** Bumped on every change, so a browser can tell its copy is old. */
  rev: number
  records: Item[]
  folders: Item[]
  /** Per drive (batch id): the dashboard's LocalDriveMetadata. */
  metadata: Record<string, Record<string, unknown>>
  shared: Item[]
  /** When each item was deleted (ms). Shared drives are keyed by their feed, see sharedKey. */
  deleted: { records: Record<string, number>; folders: Record<string, number>; shared: Record<string, number> }
}

export type DriveOp =
  | { kind: 'record' | 'folder' | 'shared'; op: 'put'; value: Item }
  | { kind: 'record' | 'folder' | 'shared'; op: 'patch'; id: string; changes: Record<string, unknown> }
  | { kind: 'record' | 'folder' | 'shared'; op: 'delete'; id: string }
  | { kind: 'metadata'; op: 'patch'; batch: string; changes: Record<string, unknown> }
  | { kind: 'metadata'; op: 'delete'; batch: string }

/** What a browser had in localStorage, sent once so the app can take it over. */
export interface DriveImport {
  records?: unknown[]
  folders?: unknown[]
  metadata?: Record<string, unknown>
  shared?: unknown[]
}

export function emptyStore(): DriveStore {
  return { version: 1, rev: 0, records: [], folders: [], metadata: {}, shared: [], deleted: emptyDeleted() }
}

function emptyDeleted(): DriveStore['deleted'] {
  return { records: {}, folders: {}, shared: {} }
}

// ─── Validation ──────────────────────────────────────────────────────────────

const MAX_ID = 200
const MAX_OPS = 500

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_ID
}

function isItem(value: unknown): value is Item {
  return isPlainObject(value) && isId(value.id)
}

/** The ops a request carries, or null when any of them is malformed (then none is applied). */
export function parseOps(value: unknown): DriveOp[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_OPS) return null

  for (const op of value) {
    if (!isPlainObject(op)) return null

    if (op.kind === 'metadata') {
      if (!isId(op.batch)) return null

      if (op.op === 'patch' ? !isPlainObject(op.changes) : op.op !== 'delete') return null
    } else if (op.kind === 'record' || op.kind === 'folder' || op.kind === 'shared') {
      if (op.op === 'put') {
        if (!isItem(op.value)) return null
      } else if (op.op === 'patch') {
        if (!isId(op.id) || !isPlainObject(op.changes)) return null
      } else if (op.op !== 'delete' || !isId(op.id)) {
        return null
      }
    } else {
      return null
    }
  }

  return value as DriveOp[]
}

// ─── Applying changes ────────────────────────────────────────────────────────

/** A patch value of null removes the field (JSON has no undefined). An id never changes. */
function patched<T extends Record<string, unknown>>(target: T, changes: Record<string, unknown>): T {
  const next: Record<string, unknown> = { ...target }

  for (const [key, value] of Object.entries(changes)) {
    if (key === 'id') continue

    if (value === null) delete next[key]
    else next[key] = value
  }

  return next as T
}

function hexKey(value: unknown): string {
  return typeof value === 'string' ? value.toLowerCase().replace(/^0x/, '') : ''
}

/**
 * A shared drive's identity is its feed (topic + owner): the same drive has a
 * different random id in every browser. Legacy entries without a feed fall back to the id.
 */
export function sharedKey(drive: Record<string, unknown>): string {
  const topic = hexKey(drive.feedTopic)
  const owner = hexKey(drive.feedOwner)

  return topic && owner ? `feed:${topic}:${owner}` : `id:${String(drive.id)}`
}

function list(store: DriveStore, kind: 'record' | 'folder' | 'shared'): Item[] {
  return kind === 'record' ? store.records : kind === 'folder' ? store.folders : store.shared
}

function setList(store: DriveStore, kind: 'record' | 'folder' | 'shared', items: Item[]): void {
  if (kind === 'record') store.records = items
  else if (kind === 'folder') store.folders = items
  else store.shared = items
}

function tombstones(store: DriveStore, kind: 'record' | 'folder' | 'shared'): Record<string, number> {
  return kind === 'record' ? store.deleted.records : kind === 'folder' ? store.deleted.folders : store.deleted.shared
}

/** A folder and every folder below it. */
function folderTree(folders: Item[], rootId: string): Set<string> {
  const ids = new Set<string>([rootId])
  let grew = true

  while (grew) {
    grew = false

    for (const f of folders) {
      if (!ids.has(f.id) && typeof f.parentFolderId === 'string' && ids.has(f.parentFolderId)) {
        ids.add(f.id)
        grew = true
      }
    }
  }

  return ids
}

/**
 * An encrypted drive's ACT state is the app's (act-head.ts): a browser holds
 * whatever it last saw, and writing that back would move the drive to an older
 * history and lose a grant. Once the app has a value, browsers can't change it;
 * `keyRotated` they may only clear (after a re-publish).
 */
const SERVER_OWNED = ['actHistoryRef', 'granteeRef', 'headsSinceRotation', 'retiredHeads'] as const

function browserChanges(current: Record<string, unknown>, changes: Record<string, unknown>): Record<string, unknown> {
  const allowed: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(changes)) {
    if ((SERVER_OWNED as readonly string[]).includes(key) && current[key] !== undefined) continue

    if (key === 'keyRotated' && value) continue
    allowed[key] = value
  }

  return allowed
}

/** An encrypted file whose history is one a revoke left behind can't be opened by current grantees. */
function flagsRetiredHead(store: DriveStore, record: Item): boolean {
  if (!record.isEncrypted || typeof record.actHistoryRef !== 'string' || typeof record.driveId !== 'string') {
    return false
  }
  const meta = store.metadata[record.driveId]
  const retired = meta?.retiredHeads

  if (!meta || !Array.isArray(retired) || !retired.includes(record.actHistoryRef) || meta.keyRotated) return false
  store.metadata[record.driveId] = { ...meta, keyRotated: true }

  return true
}

function applyOne(store: DriveStore, op: DriveOp, now: number, trusted: boolean): boolean {
  if (op.kind === 'metadata') {
    if (op.op === 'delete') {
      // Never from a browser once the app keeps the drive's ACT state.
      if (!(op.batch in store.metadata) || (!trusted && store.metadata[op.batch].actHistoryRef !== undefined)) {
        return false
      }
      delete store.metadata[op.batch]

      return true
    }
    const current = store.metadata[op.batch] ?? { encrypted: false }
    const changes = trusted ? op.changes : browserChanges(current, op.changes)

    if (Object.keys(changes).length === 0) return false
    store.metadata[op.batch] = patched(current, changes)

    return true
  }

  const items = list(store, op.kind)
  const dead = tombstones(store, op.kind)

  if (op.op === 'put') {
    if (op.kind === 'shared') {
      // Adding a shared drive is always the user's own choice: it brings back
      // one they removed before. Same feed = the same drive: update it in
      // place, keeping its id and when it was first added.
      const key = sharedKey(op.value)
      const existing = items.find(d => sharedKey(d) === key)

      delete dead[key]

      if (existing) {
        setList(
          store,
          'shared',
          items.map(d =>
            d === existing ? { ...existing, ...op.value, id: existing.id, addedAt: existing.addedAt } : d,
          ),
        )
      } else {
        items.push({ ...op.value })
      }

      return true
    }

    // A put for something deleted elsewhere comes from a browser that hasn't
    // seen the delete yet — it stays deleted.
    if (op.value.id in dead) return false
    const at = items.findIndex(i => i.id === op.value.id)

    if (at >= 0) items[at] = { ...op.value }
    else if (op.kind === 'record') items.unshift({ ...op.value })
    else items.push({ ...op.value })

    // An upload that started before a revoke finished after it: the drive needs a re-publish.
    if (op.kind === 'record') flagsRetiredHead(store, op.value)

    return true
  }

  if (op.op === 'patch') {
    const at = items.findIndex(i => i.id === op.id)

    if (at < 0) return false
    items[at] = patched(items[at], op.changes)

    return true
  }

  // delete
  if (op.kind === 'folder') {
    const gone = folderTree(store.folders, op.id)

    if (!store.folders.some(f => gone.has(f.id))) return false

    gone.forEach(id => (store.deleted.folders[id] = now))
    store.folders = store.folders.filter(f => !gone.has(f.id))
    // Files in a removed folder go back to the drive's top level.
    store.records = store.records.map(r =>
      typeof r.folderId === 'string' && gone.has(r.folderId) ? patched(r, { folderId: null }) : r,
    )

    return true
  }
  const target = items.find(i => i.id === op.id)

  if (!target) return false
  dead[op.kind === 'shared' ? sharedKey(target) : target.id] = now
  setList(
    store,
    op.kind,
    items.filter(i => i !== target),
  )

  return true
}

/** Applies the ops in order; returns whether anything changed. `trusted` = the app itself (act-head.ts). */
export function applyOps(store: DriveStore, ops: DriveOp[], now = Date.now(), trusted = false): boolean {
  let changed = false

  for (const op of ops) {
    if (applyOne(store, op, now, trusted)) changed = true
  }

  if (changed) store.rev++

  return changed
}

// ─── Taking over a browser's localStorage ────────────────────────────────────

/** The fields that only make sense together: a grantee list belongs to one ACT history. */
const HEAD_FIELDS = ['actHistoryRef', 'granteeRef', 'granteeCount'] as const

/**
 * Adds what a browser holds and the app doesn't: never deletes, never
 * overwrites, skips what was deleted. Safe to repeat (same ids → nothing to do).
 *
 * Two browsers can disagree on an encrypted drive's latest ACT history and
 * nothing tells which is newer — the first one stays, the drive is marked
 * `headConflict` and it's logged.
 */
export function importLocal(store: DriveStore, data: DriveImport, now = Date.now()): boolean {
  let changed = false

  const addItems = (kind: 'record' | 'folder', incoming: unknown[] | undefined) => {
    const items = list(store, kind)
    const dead = tombstones(store, kind)
    const have = new Set(items.map(i => i.id))

    for (const value of Array.isArray(incoming) ? incoming : []) {
      if (!isItem(value) || have.has(value.id) || value.id in dead) continue
      items.push({ ...value })
      have.add(value.id)
      changed = true
    }
  }

  addItems('record', data.records)
  addItems('folder', data.folders)

  for (const value of Array.isArray(data.shared) ? data.shared : []) {
    if (!isItem(value)) continue
    const key = sharedKey(value)

    if (key in store.deleted.shared || store.shared.some(d => sharedKey(d) === key)) continue
    store.shared.push({ ...value })
    changed = true
  }

  for (const [batch, value] of Object.entries(isPlainObject(data.metadata) ? data.metadata : {})) {
    if (!isId(batch) || !isPlainObject(value)) continue
    const current = store.metadata[batch]

    if (!current) {
      store.metadata[batch] = { ...value }
      changed = true
      continue
    }
    const next = { ...current }
    const headIn = typeof value.actHistoryRef === 'string' ? value.actHistoryRef : undefined
    const headHave = typeof current.actHistoryRef === 'string' ? current.actHistoryRef : undefined

    if (headIn && !headHave) {
      for (const field of HEAD_FIELDS) {
        if (field in value) next[field] = value[field]
      }
    } else if (headIn && headHave && headIn !== headHave && !current.headConflict) {
      next.headConflict = true
      logger.warn(`drive-data: two browsers hold different ACT histories for drive ${batch} — kept the first`)
    }

    for (const [field, fieldValue] of Object.entries(value)) {
      if ((HEAD_FIELDS as readonly string[]).includes(field) || field in next) continue
      next[field] = fieldValue
    }

    if (JSON.stringify(next) !== JSON.stringify(current)) {
      store.metadata[batch] = next
      changed = true
    }
  }

  if (changed) store.rev++

  return changed
}

// ─── The file ────────────────────────────────────────────────────────────────

let cache: DriveStore | null = null

function filePath(): string {
  return getPath(FILE)
}

function parseStore(text: string): DriveStore | null {
  const value = JSON.parse(text) as Partial<DriveStore>

  if (!isPlainObject(value) || value.version !== 1) return null

  return {
    version: 1,
    rev: typeof value.rev === 'number' ? value.rev : 0,
    records: Array.isArray(value.records) ? value.records.filter(isItem) : [],
    folders: Array.isArray(value.folders) ? value.folders.filter(isItem) : [],
    metadata: isPlainObject(value.metadata) ? (value.metadata as DriveStore['metadata']) : {},
    shared: Array.isArray(value.shared) ? value.shared.filter(isItem) : [],
    deleted: {
      ...emptyDeleted(),
      ...(isPlainObject(value.deleted) ? (value.deleted as Partial<DriveStore['deleted']>) : {}),
    },
  }
}

function readFile(path: string): DriveStore | null {
  if (!existsSync(path)) return null
  try {
    return parseStore(readFileSync(path, 'utf-8'))
  } catch (error) {
    logger.error(`drive-data: could not read ${path}: ${(error as Error).message}`)

    return null
  }
}

/**
 * The store, read once. A damaged file falls back to the previous copy
 * (`.bak`); when neither reads, the damaged file is kept aside — never
 * silently overwritten — and the store starts empty (browsers import again).
 */
export function loadDriveStore(): DriveStore {
  if (cache) return cache
  const path = filePath()
  const main = readFile(path)

  if (main) return (cache = main)

  if (existsSync(path)) {
    const backup = readFile(`${path}.bak`)

    logger.error(`drive-data: ${FILE} is damaged — ${backup ? 'using the previous copy' : 'starting empty'}`)
    try {
      copyFileSync(path, `${path}.damaged-${Date.now()}`)
    } catch {
      // best effort
    }

    if (backup) return (cache = backup)
  }

  return (cache = emptyStore())
}

/** Writes atomically (temp file + rename), keeping the previous copy as `.bak`. */
function saveDriveStore(store: DriveStore): void {
  const path = filePath()

  writeFileSync(`${path}.tmp`, JSON.stringify(store))

  if (existsSync(path) && readFile(path)) copyFileSync(path, `${path}.bak`)
  renameSync(`${path}.tmp`, path)
  cache = store
}

/** Applies a browser's ops to the stored copy and saves it when something changed. */
export function changeDriveData(ops: DriveOp[]): DriveStore {
  const store = structuredClone(loadDriveStore())

  if (applyOps(store, ops)) saveDriveStore(store)

  return loadDriveStore()
}

/** The app's own change to a drive's ACT state (act-head.ts) — not filtered like a browser's. */
export function setActState(batch: string, changes: Record<string, unknown>): void {
  const store = structuredClone(loadDriveStore())

  if (!applyOps(store, [{ kind: 'metadata', op: 'patch', batch, changes }], Date.now(), true)) return
  try {
    saveDriveStore(store)
  } catch (error) {
    // Bee already moved the head: keep it in memory at least, or the next
    // grant would build on the old one and lose this one.
    cache = store
    logger.error(`drive-data: could not save drive ${batch}'s ACT state: ${(error as Error).message}`)
  }
}

export function getActState(batch: string): Record<string, unknown> | undefined {
  return loadDriveStore().metadata[batch]
}

export function importDriveData(data: DriveImport): DriveStore {
  const store = structuredClone(loadDriveStore())

  if (importLocal(store, data)) saveDriveStore(store)

  return loadDriveStore()
}

/** Tests only: forget the copy read from disk. */
export function resetDriveDataCache(): void {
  cache = null
}
