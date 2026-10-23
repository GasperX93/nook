import { useEffect, useState } from 'react'

import { type DriveOp, sendDriveOps, toPatch } from '../store/drive-data'

export interface DriveFolder {
  id: string
  name: string
  createdAt: number
  /** batchID of the drive this folder belongs to */
  driveId: string
  parentFolderId?: string
}

export interface UploadRecord {
  id: string
  name: string
  hash: string
  size: number
  type: 'file' | 'folder' | 'website'
  /** driveId is the batchID of the stamp/drive this file belongs to */
  driveId: string
  /** stampId kept for migration compatibility — use driveId in new code */
  stampId?: string
  /** Unix timestamp (ms) when the stamp expires */
  expiresAt: number
  uploadedAt: number
  hasFeed: boolean
  feedTopic?: string
  /** Permanent feed manifest address (shareable link, stays constant across updates) */
  feedManifestAddress?: string
  /** Virtual folder this record belongs to; undefined = root level */
  folderId?: string
  /** Linked ENS domain name (e.g. "yourname.eth") */
  ensDomain?: string
  /** Whether this file was uploaded with ACT encryption */
  isEncrypted?: boolean
  /** Bee node publicKey that encrypted this file (needed for ACT download) */
  actPublisher?: string
  /** ACT history reference (needed for ACT download) */
  actHistoryRef?: string
  /**
   * Bee tag uid while the upload is still propagating to the network (#23).
   * Set at record creation (records are written BEFORE the propagation wait —
   * navigating away must never lose a file's address), cleared centrally by
   * the transfer tracker when the tag completes. Presence = "still spreading".
   */
  pendingTagUid?: number
}

const STORAGE_KEY = 'swarm-drive'
const FOLDERS_KEY = 'nook-folders'

function loadFolders(): DriveFolder[] {
  try {
    return JSON.parse(localStorage.getItem(FOLDERS_KEY) ?? '[]')
  } catch {
    return []
  }
}

function saveFolders(folders: DriveFolder[]) {
  localStorage.setItem(FOLDERS_KEY, JSON.stringify(folders))
}

function save(records: UploadRecord[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(records))
}

/**
 * Records still waiting on network propagation (#23) — the transfer tracker
 * re-follows these on app start. Standalone (non-hook) because the tracker
 * lives outside React.
 */
export function pendingPropagationRecords(): {
  tagUid: number
  name: string
  driveId: string
  hash: string
  isEncrypted: boolean
}[] {
  try {
    const records: UploadRecord[] = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]')

    return records
      .filter(r => r.pendingTagUid !== undefined)
      .map(r => ({
        tagUid: r.pendingTagUid!,
        name: r.name,
        driveId: r.driveId,
        hash: r.hash,
        isEncrypted: Boolean(r.isEncrypted),
      }))
  } catch {
    return []
  }
}

/**
 * Clear the propagation marker once a tag completes — called by the transfer
 * tracker, which may outlive the page that created the record. Direct
 * localStorage write; mounted hooks re-read on next interaction.
 */
export function clearPendingTagUid(tagUid: number): void {
  try {
    const records: UploadRecord[] = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]')
    const ops: DriveOp[] = []
    const next = records.map(r => {
      if (r.pendingTagUid !== tagUid) return r
      const { pendingTagUid: _cleared, ...rest } = r

      ops.push({ kind: 'record', op: 'patch', id: r.id, changes: { pendingTagUid: null } })

      return rest as UploadRecord
    })

    save(next)
    sendDriveOps(ops)
    // Mounted hook instances hold records in React state — poke them.
    window.dispatchEvent(new Event('nook:records-changed'))
  } catch {
    // nothing to clear
  }
}

/** Load and repair records: migrate stampId→driveId and clear orphaned folderIds */
function loadAll(): { records: UploadRecord[]; folders: DriveFolder[] } {
  const folders = loadFolders()
  // Build per-drive set of valid folder IDs so we can detect cross-drive corruption
  const driveFolderIds = new Map<string, Set<string>>()
  for (const f of folders) {
    if (!driveFolderIds.has(f.driveId)) driveFolderIds.set(f.driveId, new Set())
    driveFolderIds.get(f.driveId)!.add(f.id)
  }
  let changed = false
  // The same repairs for the app's copy, or every refresh would bring the broken values back.
  const repairs: DriveOp[] = []
  const records: UploadRecord[] = (() => {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]')
    } catch {
      return []
    }
  })().map((r: UploadRecord) => {
    let rec = r

    // Migrate old stampId → driveId
    if (!rec.driveId && rec.stampId) {
      rec = { ...rec, driveId: rec.stampId }
      repairs.push({ kind: 'record', op: 'patch', id: rec.id, changes: { driveId: rec.stampId } })
      changed = true
    }

    // Repair cross-drive drag corruption: folderId must belong to a folder in the same drive
    if (rec.folderId) {
      const validFolders = rec.driveId ? driveFolderIds.get(rec.driveId) : undefined

      if (!validFolders || !validFolders.has(rec.folderId)) {
        rec = { ...rec, folderId: undefined }
        repairs.push({ kind: 'record', op: 'patch', id: rec.id, changes: { folderId: null } })
        changed = true
      }
    }

    return rec
  })

  if (changed) {
    save(records)
    sendDriveOps(repairs)
  }

  return { records, folders }
}

/**
 * Storage-first record write (R5-2). Saving inside a React state updater
 * silently did NOTHING when the Drive page had unmounted — e.g. an encrypted
 * upload (or a classic upload still in step 1) finishing after the user
 * navigated away: the content was on Swarm but its address was never saved.
 * Write localStorage directly, then poke every mounted instance to reload —
 * the same path the transfer tracker uses (clearPendingTagUid).
 */
function persistRecords(mutate: (records: UploadRecord[]) => UploadRecord[], ops: DriveOp[]): void {
  save(mutate(loadAll().records))
  // The app's copy (store/drive-data): the same change, so every browser sees it.
  sendDriveOps(ops)
  window.dispatchEvent(new Event('nook:records-changed'))
}

/** Folders: storage-first like records (a state updater did nothing once the page had unmounted). */
function persistFolders(mutate: (folders: DriveFolder[]) => DriveFolder[], ops: DriveOp[]): void {
  saveFolders(mutate(loadFolders()))
  sendDriveOps(ops)
  window.dispatchEvent(new Event('nook:records-changed'))
}

export function useUploadHistory() {
  const [init] = useState(loadAll)
  const [records, setRecords] = useState(init.records)
  const [folders, setFolders] = useState(init.folders)

  // Out-of-band writes (the transfer tracker clearing pendingTagUid) poke
  // mounted instances via this event so rows update without a remount.
  useEffect(() => {
    const reload = () => {
      const all = loadAll()

      setRecords(all.records)
      setFolders(all.folders)
    }

    window.addEventListener('nook:records-changed', reload)

    return () => window.removeEventListener('nook:records-changed', reload)
  }, [])

  function add(record: UploadRecord) {
    persistRecords(all => [record, ...all], [{ kind: 'record', op: 'put', value: { ...record } }])
  }

  function remove(id: string) {
    persistRecords(all => all.filter(r => r.id !== id), [{ kind: 'record', op: 'delete', id }])
  }

  function update(id: string, changes: Partial<UploadRecord>) {
    persistRecords(
      all => all.map(r => (r.id === id ? { ...r, ...changes } : r)),
      [{ kind: 'record', op: 'patch', id, changes: toPatch(changes) }],
    )
  }

  function addFolder(name: string, driveId: string, parentFolderId?: string) {
    const folder: DriveFolder = {
      id: crypto.randomUUID(),
      name,
      createdAt: Date.now(),
      driveId,
      ...(parentFolderId ? { parentFolderId } : {}),
    }

    persistFolders(all => [...all, folder], [{ kind: 'folder', op: 'put', value: { ...folder } }])
  }

  function removeFolder(id: string, allFolders: DriveFolder[]) {
    // Collect the folder + all descendants recursively
    const toRemove = new Set<string>()
    const queue = [id]
    while (queue.length > 0) {
      const current = queue.pop()!
      toRemove.add(current)
      allFolders.filter(f => f.parentFolderId === current).forEach(f => queue.push(f.id))
    }
    // The app removes the folders below it and moves their files to the top level too.
    persistFolders(all => all.filter(f => !toRemove.has(f.id)), [{ kind: 'folder', op: 'delete', id }])
    persistRecords(
      all => all.map(r => (r.folderId && toRemove.has(r.folderId) ? { ...r, folderId: undefined } : r)),
      [],
    )
  }

  function renameFolder(id: string, name: string) {
    persistFolders(
      all => all.map(f => (f.id === id ? { ...f, name } : f)),
      [{ kind: 'folder', op: 'patch', id, changes: { name } }],
    )
  }

  function moveToFolder(recordId: string, folderId: string | null) {
    persistRecords(
      all => all.map(r => (r.id === recordId ? { ...r, folderId: folderId ?? undefined } : r)),
      [{ kind: 'record', op: 'patch', id: recordId, changes: { folderId } }],
    )
  }

  /** Set an ENS domain on a record, removing it from any other record that had it */
  function setEnsDomain(recordId: string, domain: string) {
    const others = loadAll().records.filter(r => r.id !== recordId && r.ensDomain === domain)

    persistRecords(
      all =>
        all.map(r => {
          if (r.id === recordId) return { ...r, ensDomain: domain }

          if (r.ensDomain === domain) return { ...r, ensDomain: undefined }

          return r
        }),
      [
        { kind: 'record', op: 'patch', id: recordId, changes: { ensDomain: domain } },
        ...others.map(r => ({ kind: 'record' as const, op: 'patch' as const, id: r.id, changes: { ensDomain: null } })),
      ],
    )
  }

  return { records, folders, add, remove, update, addFolder, removeFolder, renameFolder, moveToFolder, setEnsDomain }
}
