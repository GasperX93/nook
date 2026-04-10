/**
 * Local drive metadata — tracks which drives are encrypted and their ACT state.
 *
 * Stored in localStorage alongside custom drive labels. Source of truth for
 * encrypted state is the Swarm metadata feed, but localStorage provides fast
 * local lookup without requiring wallet connection.
 */
import { useState } from 'react'

const STORAGE_KEY = 'nook-drive-metadata'

export interface LocalDriveMetadata {
  /** Whether this drive uses ACT encryption */
  encrypted: boolean
  /** Bee node publicKey that acts as ACT publisher */
  actPublisher?: string
  /** Latest ACT history reference */
  actHistoryRef?: string
  /** Grantee list reference */
  granteeRef?: string
  /** Number of grantees (including owner) */
  granteeCount?: number
}

function load(): Record<string, LocalDriveMetadata> {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}')
  } catch {
    return {}
  }
}

function persist(data: Record<string, LocalDriveMetadata>) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data))
}

export function useDriveMetadata() {
  const [metadata, setMetadata] = useState<Record<string, LocalDriveMetadata>>(load)

  function get(batchId: string): LocalDriveMetadata | undefined {
    return metadata[batchId]
  }

  function isEncrypted(batchId: string): boolean {
    return metadata[batchId]?.encrypted === true
  }

  function set(batchId: string, data: LocalDriveMetadata) {
    setMetadata(prev => {
      const next = { ...prev, [batchId]: data }

      persist(next)

      return next
    })
  }

  function update(batchId: string, partial: Partial<LocalDriveMetadata>) {
    setMetadata(prev => {
      const existing = prev[batchId] ?? { encrypted: false }
      const next = { ...prev, [batchId]: { ...existing, ...partial } }

      persist(next)

      return next
    })
  }

  function remove(batchId: string) {
    setMetadata(prev => {
      const next = { ...prev }
      delete next[batchId]

      persist(next)

      return next
    })
  }

  return { metadata, get, isEncrypted, set, update, remove }
}
