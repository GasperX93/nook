/**
 * Re-publish an encrypted drive: re-encrypt and re-upload its files under the
 * drive's CURRENT ACT, then refresh the shared metadata feed.
 *
 * Why this exists:
 *  - Revoking a grantee ROTATES the ACT key in Bee, so the drive's existing
 *    files stay locked under the OLD key. Re-granting someone gives them the new
 *    key, but they still can't open the old files — those bytes must be
 *    re-encrypted (re-uploaded) under the current key.
 *  - It also pushes content that was originally uploaded deferred (and never
 *    reached the network) out to the network's storers via direct upload.
 *
 * The owner can decrypt their own files locally (they're the ACT publisher), so
 * we download each file, re-upload it direct under the current history (chaining
 * forward), update the local record, and rewrite the metadata feed to the new
 * references so recipients reading the feed get content they can decrypt.
 */
import { beeApi, topicFromString } from '../api/bee'
import { serverApi } from '../api/server'
import type { UploadRecord } from '../hooks/useUploadHistory'

export interface RepublishDeps {
  driveId: string
  /** All upload records belonging to this drive. */
  records: UploadRecord[]
  /** The drive's ACT publisher (Bee node public key). */
  actPublisher: string
  /** The drive's current ACT history ref (after the latest grant/revoke). */
  currentHistoryRef: string
  onProgress?: (msg: string) => void
  /** Persist a record's new reference + history after re-upload. */
  onRecordUpdate: (id: string, changes: Partial<UploadRecord>) => void
  /** Persist the drive's new latest history ref. */
  onHistoryUpdate: (historyRef: string) => void
  /** Latest public wrapper ref after the metadata rebuild (#93 health checks). */
  onWrapperRef?: (ref: string) => void
}

export async function republishDrive(deps: RepublishDeps): Promise<void> {
  const { driveId, records, actPublisher, onProgress, onRecordUpdate, onHistoryUpdate, onWrapperRef } = deps

  // Only single files are round-trippable via ACT download/upload here.
  // (Folders/websites are collections — re-publishing those is a follow-up.)
  const files = records.filter(r => r.isEncrypted && r.actHistoryRef && r.type === 'file')

  if (files.length === 0) {
    throw new Error('No encrypted files to re-publish in this drive.')
  }

  let currentHistory = deps.currentHistoryRef
  const rebuilt: { name: string; reference: string; historyRef: string; size: number }[] = []

  for (let i = 0; i < files.length; i++) {
    const rec = files[i]

    onProgress?.(`Re-publishing ${i + 1} of ${files.length}: ${rec.name}`)

    // Download decrypted content (owner holds the key + has it locally), then
    // re-upload it direct under the current ACT so current grantees can read it.
    const blob = await beeApi.downloadFileWithACT(rec.hash, actPublisher, rec.actHistoryRef!)
    const file = new File([blob], rec.name, { type: blob.type || 'application/octet-stream' })
    const result = await beeApi.uploadFileWithACT(file, driveId, currentHistory)

    if (result.historyAddress) currentHistory = result.historyAddress

    onRecordUpdate(rec.id, { hash: result.reference, actHistoryRef: result.historyAddress })
    rebuilt.push({ name: rec.name, reference: result.reference, historyRef: result.historyAddress, size: rec.size })
  }

  // Rebuild the shared metadata feed against the final history so recipients
  // reading the feed get the new, decryptable references.
  onProgress?.('Updating shared metadata…')
  const topic = await topicFromString(driveId + 'nook-drive-meta')
  const metadata = JSON.stringify({ files: rebuilt })
  const uploaded = await serverApi.uploadACTMetadata(driveId, metadata, currentHistory)
  const wrapper = JSON.stringify({ ref: uploaded.reference, history: uploaded.historyRef })
  const wrapperResult = await serverApi.uploadRawBytes(driveId, wrapper)

  await serverApi.createFeedUpdate(topic, wrapperResult.reference, driveId)
  onHistoryUpdate(uploaded.historyRef)
  onWrapperRef?.(wrapperResult.reference)
}
