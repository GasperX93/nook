import { useState } from 'react'

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
      changed = true
    }
    // Repair cross-drive drag corruption: folderId must belong to a folder in the same drive
    if (rec.folderId) {
      const validFolders = rec.driveId ? driveFolderIds.get(rec.driveId) : undefined
      if (!validFolders || !validFolders.has(rec.folderId)) {
        rec = { ...rec, folderId: undefined }
        changed = true
      }
    }
    return rec
  })
  if (changed) save(records)
  return { records, folders }
}

export function useUploadHistory() {
  const [init] = useState(loadAll)
  const [records, setRecords] = useState(init.records)
  const [folders, setFolders] = useState(init.folders)

  function add(record: UploadRecord) {
    setRecords(prev => {
      const next = [record, ...prev]
      save(next)
      return next
    })
  }

  function remove(id: string) {
    setRecords(prev => {
      const next = prev.filter(r => r.id !== id)
      save(next)
      return next
    })
  }

  function update(id: string, changes: Partial<UploadRecord>) {
    setRecords(prev => {
      const next = prev.map(r => (r.id === id ? { ...r, ...changes } : r))
      save(next)
      return next
    })
  }

  function addFolder(name: string, driveId: string, parentFolderId?: string) {
    const folder: DriveFolder = {
      id: crypto.randomUUID(),
      name,
      createdAt: Date.now(),
      driveId,
      ...(parentFolderId ? { parentFolderId } : {}),
    }
    setFolders(prev => {
      const next = [...prev, folder]
      saveFolders(next)
      return next
    })
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
    setFolders(prev => {
      const next = prev.filter(f => !toRemove.has(f.id))
      saveFolders(next)
      return next
    })
    setRecords(prev => {
      const next = prev.map(r =>
        r.folderId && toRemove.has(r.folderId) ? { ...r, folderId: undefined } : r,
      )
      save(next)
      return next
    })
  }

  function renameFolder(id: string, name: string) {
    setFolders(prev => {
      const next = prev.map(f => (f.id === id ? { ...f, name } : f))
      saveFolders(next)
      return next
    })
  }

  function moveToFolder(recordId: string, folderId: string | null) {
    setRecords(prev => {
      const next = prev.map(r =>
        r.id === recordId ? { ...r, folderId: folderId ?? undefined } : r,
      )
      save(next)
      return next
    })
  }

  /** Set an ENS domain on a record, removing it from any other record that had it */
  function setEnsDomain(recordId: string, domain: string) {
    setRecords(prev => {
      const next = prev.map(r => {
        if (r.id === recordId) return { ...r, ensDomain: domain }
        if (r.ensDomain === domain) return { ...r, ensDomain: undefined }
        return r
      })
      save(next)
      return next
    })
  }

  return { records, folders, add, remove, update, addFolder, removeFolder, renameFolder, moveToFolder, setEnsDomain }
}
