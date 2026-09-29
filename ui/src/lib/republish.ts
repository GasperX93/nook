/**
 * Re-publish an encrypted drive: re-encrypt and re-upload its content under
 * the drive's CURRENT ACT, then refresh the shared metadata feed.
 *
 * Why this exists:
 *  - Revoking a grantee ROTATES the ACT key in Bee, so the drive's existing
 *    content stays locked under the OLD key. Re-granting someone gives them the
 *    new key, but they still can't open the old content — those bytes must be
 *    re-encrypted (re-uploaded) under the current key.
 *  - It also pushes content that was originally uploaded deferred (and never
 *    reached the network) out to the network's storers via direct upload.
 *
 * The owner can decrypt their own content locally (they're the ACT publisher):
 * files are round-tripped directly; folders/websites are enumerated via their
 * mantaray manifest (ACT-aware since bee-js 12), every entry downloaded and
 * the collection re-uploaded as a whole. Each re-upload chains the history
 * forward; the metadata feed is rewritten last so recipients reading the feed
 * get references they can decrypt.
 */
import { Bee, MantarayNode } from '@ethersphere/bee-js'

import { beeApi, getBeeUrl, topicFromString } from '../api/bee'
import { serverApi } from '../api/server'
import type { FileEntry } from '../utils/directory'
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

/**
 * Enumerate an ACT-encrypted collection's entries and download their bytes
 * (owner-side decrypt) so the collection can be re-uploaded under the current
 * key. Also recovers the index/error documents from the manifest root.
 */
async function downloadCollectionEntries(
  rec: UploadRecord,
  actPublisher: string,
): Promise<{ entries: FileEntry[]; indexDocument?: string; errorDocument?: string }> {
  const bee = new Bee(getBeeUrl())
  const act = { actPublisher, actHistoryAddress: rec.actHistoryRef! }
  const root = await MantarayNode.unmarshal(bee, rec.hash, act)

  await root.loadRecursively(bee, act)
  const docs = root.getDocsMetadata()
  const entries: FileEntry[] = []

  for (const path of Object.keys(root.collectAndMap())) {
    // The docs-metadata fork ("/") carries no content — skip non-file nodes.
    const clean = path.replace(/^\//, '')

    if (!clean) continue
    // bee-js native ACT download (the Koa /act/download route only handles
    // single references, not manifest subpaths).
    const file = await bee.downloadFile(rec.hash, clean, act)
    const name = clean.split('/').pop() ?? clean

    entries.push({
      path: clean,
      file: new File([file.data.toUint8Array() as BlobPart], name, {
        type: file.contentType || 'application/octet-stream',
      }),
    })
  }

  return { entries, indexDocument: docs.indexDocument ?? undefined, errorDocument: docs.errorDocument ?? undefined }
}

export async function republishDrive(deps: RepublishDeps): Promise<void> {
  const { driveId, records, actPublisher, onProgress, onRecordUpdate, onHistoryUpdate, onWrapperRef } = deps

  const items = records.filter(r => r.isEncrypted && r.actHistoryRef)

  if (items.length === 0) {
    throw new Error('No encrypted content to re-publish in this drive.')
  }

  let currentHistory = deps.currentHistoryRef
  const rebuilt: { name: string; reference: string; historyRef: string; size: number }[] = []

  for (let i = 0; i < items.length; i++) {
    const rec = items[i]

    onProgress?.(`Re-publishing ${i + 1} of ${items.length}: ${rec.name}`)

    let result: { reference: string; historyAddress: string }

    if (rec.type === 'file') {
      // Download decrypted content (owner holds the key + has it locally), then
      // re-upload it direct under the current ACT so current grantees can read it.
      const blob = await beeApi.downloadFileWithACT(rec.hash, actPublisher, rec.actHistoryRef!)
      const file = new File([blob], rec.name, { type: blob.type || 'application/octet-stream' })

      result = await beeApi.uploadFileWithACT(file, driveId, currentHistory)
    } else {
      // Folder/website: enumerate the manifest, download every entry, re-upload
      // the collection as a whole under the current key.
      const { entries, indexDocument, errorDocument } = await downloadCollectionEntries(rec, actPublisher)

      if (entries.length === 0) throw new Error(`"${rec.name}" has no readable entries to re-publish.`)
      const opts = rec.type === 'website' ? { indexDocument: indexDocument ?? 'index.html', errorDocument } : undefined

      result = await beeApi.uploadCollectionWithACT(entries, driveId, currentHistory, opts)
    }

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
