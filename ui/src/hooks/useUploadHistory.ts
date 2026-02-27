import { useState } from 'react'

export interface DriveFolder {
  id: string
  name: string
  createdAt: number
}

export interface UploadRecord {
  id: string
  name: string
  hash: string
  size: number
  type: 'file' | 'folder' | 'website'
  stampId: string
  /** Unix timestamp (ms) when the stamp expires */
  expiresAt: number
  uploadedAt: number
  hasFeed: boolean
  feedTopic?: string
  /** Permanent feed manifest address (shareable link, stays constant across updates) */
  feedManifestAddress?: string
  /** Drive folder id; undefined = root level */
  folderId?: string
}

const STORAGE_KEY = 'swarm-drive'
const FOLDERS_KEY = 'nook-folders'

function load(): UploadRecord[] {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]')
  } catch {
    return []
  }
}

function save(records: UploadRecord[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(records))
}

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

export function useUploadHistory() {
  const [records, setRecords] = useState<UploadRecord[]>(load)
  const [folders, setFolders] = useState<DriveFolder[]>(loadFolders)

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

  function addFolder(name: string) {
    const folder: DriveFolder = {
      id: crypto.randomUUID(),
      name,
      createdAt: Date.now(),
    }
    setFolders(prev => {
      const next = [...prev, folder]
      saveFolders(next)

      return next
    })
  }

  function removeFolder(id: string) {
    setFolders(prev => {
      const next = prev.filter(f => f.id !== id)
      saveFolders(next)

      return next
    })
    // unassign records from deleted folder
    setRecords(prev => {
      const next = prev.map(r => (r.folderId === id ? { ...r, folderId: undefined } : r))
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
      const next = prev.map(r => (r.id === recordId ? { ...r, folderId: folderId ?? undefined } : r))
      save(next)

      return next
    })
  }

  return { records, folders, add, remove, update, addFolder, removeFolder, renameFolder, moveToFolder }
}
