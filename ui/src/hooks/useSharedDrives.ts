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
  fromLabel?: string
  /** Feed-based sharing (live file list) */
  feedTopic?: string
  feedOwner?: string
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

export interface ParsedShareLink {
  type: 'feed' | 'snapshot'
  // Feed-based (live)
  feedTopic?: string
  feedOwner?: string
  actPublisher: string
  // Snapshot-based (legacy)
  reference?: string
  actHistoryRef?: string
}

/** Parse a share link into its components. Supports both feed-based and legacy snapshot links. */
export function parseShareLink(link: string): ParsedShareLink | null {
  try {
    const clean = link.trim().replace('swarm://', '')
    const [path, query] = clean.split('?')

    if (!query) return null

    const params = new URLSearchParams(query)
    const actPublisher = params.get('publisher')

    if (!actPublisher) return null

    // Feed-based: swarm://feed?topic=...&owner=...&publisher=...
    if (path === 'feed') {
      const feedTopic = params.get('topic')
      const feedOwner = params.get('owner')

      if (!feedTopic || !feedOwner) return null

      return { type: 'feed', feedTopic, feedOwner, actPublisher }
    }

    // Legacy snapshot: swarm://reference?publisher=...&history=...
    const actHistoryRef = params.get('history')

    if (!actHistoryRef || path.length < 64) return null

    return { type: 'snapshot', reference: path, actPublisher, actHistoryRef }
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

  function reload() {
    setDrives(load())
  }

  return { drives, add, remove, reload }
}
