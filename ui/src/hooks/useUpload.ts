import { beeApi, topicFromString, waitWhileBeeDown } from '../api/bee'
import { serverApi } from '../api/server'
import { followTagPropagation } from '../store/transfers'
import { detectIndexDocument, type FileEntry } from '../utils/directory'
import { withUploadRetries } from '../lib/upload-retry'
import {
  UPLOAD_ENCRYPTED,
  UPLOAD_PAUSED,
  UPLOAD_RESUMING,
  UPLOAD_STEP_LOCAL,
  UPLOAD_STEP_NETWORK,
} from '../lib/transfer-labels'
import { useUploadHistory } from './useUploadHistory'

export interface UploadOptions {
  entries: FileEntry[]
  type: 'file' | 'folder' | 'website'
  driveId: string
  name: string
  indexDocument?: string
  feedEnabled?: boolean
  feedTopic?: string
  /** Whether this drive uses ACT encryption */
  encrypted?: boolean
  /** ACT history reference (from previous upload or grantee creation) */
  actHistoryRef?: string
  onPhase?: (phase: string) => void
  onProgress?: (pct: number | null) => void
  /** Called with the upload's Bee tag once known — lets the caller show the propagation visual (R4-7). */
  onTag?: (tagUid: number) => void
}

export interface UploadResult {
  hash: string
  expiresAt: number
  feedManifestAddress?: string
  recordId: string
  /** Updated ACT history ref (if encrypted upload) */
  actHistoryRef?: string
}

/** Pause while Bee is stopped or restarting, saying so (R8-3). Returns whether it waited. */
async function pauseWhileBeeDown(onPhase?: (phase: string) => void): Promise<boolean> {
  return waitWhileBeeDown(wait => onPhase?.(wait === 'node' ? UPLOAD_PAUSED : UPLOAD_RESUMING))
}

/**
 * Poll until the stamp is usable, with elapsed-time feedback.
 * Throws if stamp does not become usable within 2 minutes of Bee being up —
 * time with Bee stopped is a pause, not part of the wait (R8-3).
 */
async function pollStampUsable(id: string, onPhase?: (phase: string) => void): Promise<void> {
  let elapsed = 0

  while (elapsed < 120) {
    let paused = false

    onPhase?.(`Waiting for storage confirmation… ${elapsed > 0 ? `(${elapsed}s)` : ''}`.trim())

    try {
      const s = await beeApi.getStamp(id)

      if (s.usable) return
    } catch {
      // stamp not yet confirmed — or Bee is down (then it's a pause, not waiting)
      if (await pauseWhileBeeDown(onPhase)) paused = true
    }

    if (!paused) {
      await new Promise(r => setTimeout(r, 2000))
      elapsed += 2
    }
  }

  throw new Error(
    'The storage for this site didn’t become ready within 2 minutes. Try again — your storage is already paid for.',
  )
}

export function useUpload() {
  const { records, add: addRecord, update: updateRecord, setEnsDomain } = useUploadHistory()

  async function upload(options: UploadOptions): Promise<UploadResult> {
    const {
      entries,
      type,
      driveId,
      name,
      indexDocument,
      feedEnabled = false,
      feedTopic,
      encrypted = false,
      actHistoryRef,
      onPhase,
      onProgress,
      onTag,
    } = options

    // Poll stamp usability before uploading
    await pollStampUsable(driveId, onPhase)

    // After stamp reports usable, Bee's upload endpoint needs additional time
    // to propagate internally (~1-2 min per official Swarm tooling guidance).
    // Count down visibly so the user knows we're not stuck. The count holds
    // while Bee is down — it's Bee's own warm-up we're waiting out (R8-3).
    for (let s = 60; s > 0; s--) {
      if (s % 5 === 0) await pauseWhileBeeDown(onPhase)
      onPhase?.(`Preparing storage… ${s}s`)
      await new Promise(r => setTimeout(r, 1000))
    }

    // Upload with retry — Bee's stamp issuer may need a moment to load
    // even after the stamp reports as usable via REST.
    let currentHistoryRef = actHistoryRef

    async function doUpload(): Promise<{ reference: string; historyAddress?: string; tagUid?: number }> {
      onPhase?.(encrypted ? UPLOAD_ENCRYPTED : UPLOAD_STEP_LOCAL)
      onProgress?.(0)

      if (encrypted) {
        // ACT-encrypted upload
        if (type === 'file') {
          return beeApi.uploadFileWithACT(entries[0].file, driveId, currentHistoryRef, pct => onProgress?.(pct))
        }

        const autoIndex = indexDocument ?? detectIndexDocument(entries) ?? 'index.html'
        const opts = type === 'website' ? { indexDocument: autoIndex, errorDocument: '404.html' } : undefined

        return beeApi.uploadCollectionWithACT(entries, driveId, currentHistoryRef, opts, pct => onProgress?.(pct))
      }

      // Regular (non-encrypted) upload — deferred, so bytes land on the LOCAL
      // node first. A tag (#92) tracks the real network propagation afterwards.
      let tagUid: number | undefined

      try {
        tagUid = (await beeApi.createTag()).uid
      } catch {
        // Tags unavailable — upload proceeds without stage-2 progress.
      }

      if (type === 'file') {
        const res = await beeApi.uploadFileWithProgress(
          entries[0].file,
          driveId,
          pct => onProgress?.(pct),
          true,
          tagUid,
        )

        return { reference: res.reference, tagUid }
      }

      const autoIndex = indexDocument ?? detectIndexDocument(entries) ?? 'index.html'
      const opts =
        type === 'website'
          ? { indexDocument: autoIndex, errorDocument: '404.html', deferred: true, tagUid }
          : { deferred: true, tagUid }
      const res = await beeApi.uploadCollectionWithProgress(entries, driveId, opts, pct => onProgress?.(pct))

      return { reference: res.reference, tagUid }
    }

    // Outages don't use up attempts — up to a point: a Bee that keeps going
    // down mid-copy must not retry forever (R8-3 follow-up).
    const result = await withUploadRetries(doUpload, {
      attempts: 8,
      delayMs: 10_000,
      pause: async () => pauseWhileBeeDown(onPhase),
      onRetry: retry => onPhase?.(`Finalising storage… (retry ${retry})`),
    })
    const reference = result.reference
    const uploadHistoryAddress = result.historyAddress
    const uploadTagUid = result.tagUid

    // Update history ref for next upload in same session
    if (uploadHistoryAddress) currentHistoryRef = uploadHistoryAddress

    // Fetch current stamp TTL to set accurate expiry
    let expiresAt: number
    try {
      const stamp = await beeApi.getStamp(driveId)
      expiresAt = Date.now() + stamp.batchTTL * 1000
    } catch {
      // fallback: 3 months
      expiresAt = Date.now() + 3 * 30 * 24 * 60 * 60 * 1000
    }

    // Record FIRST (#23): the local upload succeeded — persist the address
    // before the long propagation wait so leaving the wizard can't lose it.
    // Feed details are patched in below once created.
    const pendingTag = uploadTagUid !== undefined && !encrypted ? uploadTagUid : undefined
    // A retry after a failed later step (e.g. the permanent address) uploads
    // the same content to the same drive — Swarm gives it the same address —
    // so it updates that record instead of adding a duplicate.
    const existing = records.find(r => r.driveId === driveId && r.hash === reference && r.type === type)
    const recordId = existing?.id ?? crypto.randomUUID()
    const record = {
      id: recordId,
      name,
      hash: reference,
      size: entries.reduce((sum, e) => sum + e.file.size, 0),
      type,
      driveId,
      expiresAt,
      uploadedAt: Date.now(),
      hasFeed: false,
      isEncrypted: encrypted || undefined,
      actHistoryRef: uploadHistoryAddress || undefined,
      ...(pendingTag !== undefined ? { pendingTagUid: pendingTag } : {}),
    }

    if (existing) updateRecord(recordId, record)
    else addRecord(record)

    // Stage 2 (#92): the XHR bar only measured bytes reaching the LOCAL node.
    // For deferred uploads, follow the tag until the content is actually on the
    // network. A stall is a soft outcome — the background pusher keeps working,
    // so warn in the phase text but never fail the upload here.
    if (uploadTagUid !== undefined && !encrypted) {
      onPhase?.(UPLOAD_STEP_NETWORK)
      onProgress?.(0)
      onTag?.(uploadTagUid)
      // Global tracker (#4/#5): survives navigation, feeds the sidebar
      // indicator, rings the bell on completion.
      const { complete } = await followTagPropagation(uploadTagUid, name, driveId, pct => onProgress?.(pct))

      if (!complete) {
        onPhase?.('Still storing in the background…')
        await new Promise(r => setTimeout(r, 1500))
      }
    }

    onProgress?.(null)

    // Create feed if enabled (only for Website Publisher, not Drive uploads)
    let feedManifestAddress: string | undefined

    if (feedEnabled) {
      onPhase?.('Creating the permanent address…')
      const topicName = feedTopic?.trim() || name
      const topicHex = await topicFromString(topicName)
      const result = await serverApi.createFeedUpdate(topicHex, reference, driveId)
      feedManifestAddress = result.feedManifestAddress
      updateRecord(recordId, {
        hasFeed: true,
        feedTopic: feedTopic?.trim() || name,
        feedManifestAddress,
      })
    }

    return { hash: reference, expiresAt, feedManifestAddress, recordId, actHistoryRef: uploadHistoryAddress }
  }

  return { upload, updateRecord, setEnsDomain }
}
