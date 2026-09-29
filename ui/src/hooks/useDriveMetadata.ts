/**
 * Local drive metadata — tracks which drives are encrypted and their ACT state.
 *
 * Stored in localStorage alongside custom drive labels. Source of truth for
 * encrypted state is the Swarm metadata feed, but localStorage provides fast
 * local lookup without requiring wallet connection.
 */
import { useEffect, useState } from 'react'

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
  /**
   * Set when a grantee was revoked. Revoke rotates the ACT key in Bee, so the
   * drive's existing files are now encrypted under the old key — anyone granted
   * (or re-granted) afterwards can't open them until the drive is re-published
   * (re-uploaded under the current key). Cleared after a successful re-publish.
   */
  keyRotated?: boolean
  /**
   * Wallet-derived Nook address of the user who created this drive. Optional
   * for back-compat with drives created before this field landed. Used as the
   * migration anchor when Swarm ships portable stamps + ACT-with-external-
   * signer: the drive can be re-anchored from bpub to this wpub.
   */
  creatorWpub?: string
  /**
   * Latest metadata-feed WRAPPER reference (public bytes). This is the first
   * thing a share recipient resolves (feed → wrapper → metadata), and — unlike
   * the ACT-encrypted file refs — it's a real content address that stewardship
   * can verify. Used by the drive-health check (#93).
   */
  lastWrapperRef?: string
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

const CHANGED_EVENT = 'nook:drive-metadata-changed'

/**
 * Storage-first write, same as useUploadHistory's persistRecords: saving
 * inside a React state updater did nothing once the Drive page had unmounted
 * — an encrypted upload finishing after the user navigated away never saved
 * its new ACT history ref, and the next share or upload built on the stale
 * one. Write localStorage from its current contents, then tell every mounted
 * instance to reload.
 */
function write(mutate: (data: Record<string, LocalDriveMetadata>) => Record<string, LocalDriveMetadata>) {
  persist(mutate(load()))
  window.dispatchEvent(new Event(CHANGED_EVENT))
}

export function useDriveMetadata() {
  const [metadata, setMetadata] = useState<Record<string, LocalDriveMetadata>>(load)

  useEffect(() => {
    const reload = () => setMetadata(load())

    window.addEventListener(CHANGED_EVENT, reload)

    return () => window.removeEventListener(CHANGED_EVENT, reload)
  }, [])

  function get(batchId: string): LocalDriveMetadata | undefined {
    return metadata[batchId]
  }

  function isEncrypted(batchId: string): boolean {
    return metadata[batchId]?.encrypted === true
  }

  function set(batchId: string, data: LocalDriveMetadata) {
    write(all => ({ ...all, [batchId]: data }))
  }

  function update(batchId: string, partial: Partial<LocalDriveMetadata>) {
    write(all => ({ ...all, [batchId]: { ...(all[batchId] ?? { encrypted: false }), ...partial } }))
  }

  function remove(batchId: string) {
    write(all => {
      const next = { ...all }
      delete next[batchId]

      return next
    })
  }

  return { metadata, get, isEncrypted, set, update, remove }
}
