import { beeApi, topicFromString } from '../api/bee'
import { serverApi } from '../api/server'
import { detectIndexDocument, type FileEntry } from '../utils/directory'
import { useUploadHistory } from './useUploadHistory'

export interface UploadOptions {
  entries: FileEntry[]
  type: 'file' | 'folder' | 'website'
  driveId: string
  name: string
  indexDocument?: string
  feedEnabled?: boolean
  feedTopic?: string
  onPhase?: (phase: string) => void
  onProgress?: (pct: number | null) => void
}

export interface UploadResult {
  hash: string
  expiresAt: number
  feedManifestAddress?: string
  recordId: string
}

/**
 * Poll until the stamp is usable, with elapsed-time feedback.
 * Throws if stamp does not become usable within 2 minutes.
 */
async function pollStampUsable(
  id: string,
  onPhase?: (phase: string) => void,
): Promise<void> {
  for (let i = 0; i < 60; i++) {
    const elapsed = i * 2
    onPhase?.(
      `Waiting for storage confirmation… ${elapsed > 0 ? `(${elapsed}s)` : ''}`.trim(),
    )

    try {
      const s = await beeApi.getStamp(id)
      if (s.usable) return
    } catch {
      // stamp not yet confirmed — keep polling
    }

    await new Promise(r => setTimeout(r, 2000))
  }

  throw new Error('Stamp did not become usable after 2 minutes. It may be expired or invalid.')
}

export function useUpload() {
  const { add: addRecord, update: updateRecord, setEnsDomain } = useUploadHistory()

  async function upload(options: UploadOptions): Promise<UploadResult> {
    const {
      entries,
      type,
      driveId,
      name,
      indexDocument,
      feedEnabled = false,
      feedTopic,
      onPhase,
      onProgress,
    } = options

    // Poll stamp usability before uploading
    await pollStampUsable(driveId, onPhase)

    // After stamp reports usable, Bee's upload endpoint needs additional time
    // to propagate internally (~1-2 min per official Swarm tooling guidance).
    // Count down visibly so the user knows we're not stuck.
    for (let s = 60; s > 0; s--) {
      onPhase?.(`Preparing storage… ${s}s`)
      await new Promise(r => setTimeout(r, 1000))
    }

    // Upload with retry — Bee's stamp issuer may need a moment to load
    // even after the stamp reports as usable via REST.
    async function doUpload(attempt: number): Promise<string> {
      if (attempt > 1) {
        onPhase?.(`Finalising storage… (retry ${attempt - 1})`)
        await new Promise(r => setTimeout(r, 10000))
      }

      onPhase?.('Uploading…')
      onProgress?.(0)

      if (type === 'file') {
        const res = await beeApi.uploadFileWithProgress(
          entries[0].file,
          driveId,
          pct => onProgress?.(pct),
          true,
        )
        return res.reference
      }

      const autoIndex = indexDocument ?? detectIndexDocument(entries) ?? 'index.html'
      const opts =
        type === 'website'
          ? { indexDocument: autoIndex, errorDocument: '404.html', deferred: true }
          : { deferred: true }
      const res = await beeApi.uploadCollectionWithProgress(
        entries,
        driveId,
        opts,
        pct => onProgress?.(pct),
      )
      return res.reference
    }

    let reference!: string
    for (let attempt = 1; attempt <= 8; attempt++) {
      try {
        reference = await doUpload(attempt)
        break
      } catch (err) {
        const msg = err instanceof Error ? err.message : ''
        // Overissued stamp cannot be recovered by retrying — fail immediately
        if (msg.includes('overissued') || msg.includes('402')) throw err
        if (attempt === 8) throw err
        // stamp issuer may not be loaded yet — retry
      }
    }

    onProgress?.(null)

    // Create feed if enabled (only for Website Publisher, not Drive uploads)
    let feedManifestAddress: string | undefined
    if (feedEnabled) {
      onPhase?.('Creating feed…')
      const topicName = feedTopic?.trim() || name
      const topicHex = await topicFromString(topicName)
      const result = await serverApi.createFeedUpdate(topicHex, reference, driveId)
      feedManifestAddress = result.feedManifestAddress
    }

    // Fetch current stamp TTL to set accurate expiry
    let expiresAt: number
    try {
      const stamp = await beeApi.getStamp(driveId)
      expiresAt = Date.now() + stamp.batchTTL * 1000
    } catch {
      // fallback: 3 months
      expiresAt = Date.now() + 3 * 30 * 24 * 60 * 60 * 1000
    }

    const recordId = crypto.randomUUID()
    addRecord({
      id: recordId,
      name,
      hash: reference,
      size: entries.reduce((sum, e) => sum + e.file.size, 0),
      type,
      driveId,
      expiresAt,
      uploadedAt: Date.now(),
      hasFeed: feedEnabled,
      feedTopic: feedEnabled ? (feedTopic?.trim() || name) : undefined,
      feedManifestAddress,
    })

    return { hash: reference, expiresAt, feedManifestAddress, recordId }
  }

  return { upload, updateRecord, setEnsDomain }
}
