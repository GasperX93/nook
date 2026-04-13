/**
 * Shared drives — drives other users have shared with you via share links.
 * Stored in localStorage. Read-only (you can download but not upload).
 */
import { useState } from 'react'

const STORAGE_KEY = 'nook-shared-drives'

export interface SharedFile {
  name: string
  reference: string
  historyRef: string
  size: number
}

export interface SharedDrive {
  id: string
  name: string
  reference: string
  actPublisher: string
  actHistoryRef: string
  addedAt: number
  files?: SharedFile[]
}

function load(): SharedDrive[] {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]')
  } catch {
    return []
  }
}

function persist(drives: SharedDrive[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(drives))
}

/** Parse a share link into its components. Returns null if invalid. */
export function parseShareLink(
  link: string,
): { reference: string; actPublisher: string; actHistoryRef: string } | null {
  try {
    // Format: swarm://reference?publisher=...&history=...
    const clean = link.trim().replace('swarm://', '')
    const [reference, query] = clean.split('?')

    if (!reference || !query) return null

    const params = new URLSearchParams(query)
    const actPublisher = params.get('publisher')
    const actHistoryRef = params.get('history')

    if (!actPublisher || !actHistoryRef) return null

    if (reference.length < 64) return null

    return { reference, actPublisher, actHistoryRef }
  } catch {
    return null
  }
}

export function useSharedDrives() {
  const [drives, setDrives] = useState<SharedDrive[]>(load)

  function add(drive: Omit<SharedDrive, 'id' | 'addedAt'>) {
    const newDrive: SharedDrive = {
      ...drive,
      id: crypto.randomUUID(),
      addedAt: Date.now(),
    }

    setDrives(prev => {
      const next = [...prev, newDrive]

      persist(next)

      return next
    })

    return newDrive
  }

  function remove(id: string) {
    setDrives(prev => {
      const next = prev.filter(d => d.id !== id)

      persist(next)

      return next
    })
  }

  return { drives, add, remove }
}
