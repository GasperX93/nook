/**
 * Per-stamp metadata feeds for encrypted drives.
 *
 * Each encrypted drive stores its metadata in a Swarm feed signed by
 * the wallet-derived key. Metadata content is ACT-encrypted so only
 * grantees can read it.
 *
 * Feed topic: keccak256(batchId + "nook-drive-meta")
 * Signer: wallet-derived signing key (from Phase 1 NookSigner)
 * Content: ACT-encrypted JSON (file list, drive info)
 */
import { Bee } from '@ethersphere/bee-js'

import { beeApi, getBeeUrl } from './bee'
import { topicFromString } from './bee'
import { serverApi } from './server'
import type { NookSigner } from '../crypto/signer'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface DriveFileEntry {
  name: string
  reference: string
  historyRef: string // ACT history ref for this file
  size: number
  type: string // MIME type
  uploadedAt: number
}

export interface DriveMetadata {
  name: string
  encrypted: boolean
  created: number
  actPublisher: string // Bee node's publicKey that encrypted the content
  actHistoryRef: string // latest ACT history reference for metadata
  granteeRef: string // grantee list reference
  granteeCount: number
  files: DriveFileEntry[]
}

// ─── Feed topic ───────────────────────────────────────────────────────────────

/** Compute the feed topic for a drive's metadata feed */
export async function driveFeedTopic(batchId: string): Promise<string> {
  return topicFromString(batchId + 'nook-drive-meta')
}

// ─── Read / Write ─────────────────────────────────────────────────────────────

/** Create a Bee instance with the wallet-derived signer for feed operations */
function makeBeeWithSigner(signer: NookSigner): Bee {
  const signingKey = signer.getSigningKey()
  const keyHex = Array.from(signingKey)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')

  return new Bee(getBeeUrl(), { signer: keyHex })
}

/**
 * Read drive metadata from a per-stamp feed.
 * Returns null if the feed doesn't exist or can't be decrypted.
 * Requires ACT access (must be a grantee).
 */
export async function readDriveMetadata(
  signer: NookSigner,
  batchId: string,
  actPublisher: string,
  actHistoryRef: string,
): Promise<DriveMetadata | null> {
  try {
    const bee = makeBeeWithSigner(signer)
    const topic = await driveFeedTopic(batchId)
    const reader = bee.makeFeedReader(topic, signer.getAddress())
    const result = await reader.downloadReference()
    const ref = result.reference.toHex()

    // Download via ACT proxy (metadata is ACT-encrypted)
    const blob = await beeApi.downloadFileWithACT(ref, actPublisher, actHistoryRef)
    const text = await blob.text()

    return JSON.parse(text) as DriveMetadata
  } catch {
    return null
  }
}

/**
 * Write drive metadata to a per-stamp feed.
 * Content is ACT-encrypted so only grantees can read it.
 */
export async function writeDriveMetadata(
  signer: NookSigner,
  batchId: string,
  metadata: DriveMetadata,
): Promise<{ metadataRef: string; metadataHistoryRef: string }> {
  const bee = makeBeeWithSigner(signer)
  const topic = await driveFeedTopic(batchId)
  const jsonStr = JSON.stringify(metadata)

  // Upload metadata with ACT encryption via server proxy
  const uploaded = await serverApi.uploadACTMetadata(batchId, jsonStr, metadata.actHistoryRef || undefined)

  // Write the ACT-encrypted reference to the feed
  const writer = bee.makeFeedWriter(topic)

  await writer.uploadReference(batchId, uploaded.reference)

  return { metadataRef: uploaded.reference, metadataHistoryRef: uploaded.historyRef }
}
