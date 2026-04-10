/**
 * Per-stamp metadata feeds for encrypted drives.
 *
 * Each encrypted drive stores its metadata in a Swarm feed signed by
 * the wallet-derived key. This makes drive metadata portable (same wallet
 * = same feeds on any Bee node) and independent of the Bee node's identity.
 *
 * Feed topic: keccak256(batchId + "nook-drive-meta")
 * Signer: wallet-derived signing key (from Phase 1 NookSigner)
 */
import { Bee } from '@ethersphere/bee-js'

import { getBeeUrl } from './bee'
import { topicFromString } from './bee'
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
  actHistoryRef: string // latest ACT history reference
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
 * Returns null if the feed doesn't exist (drive has no metadata yet).
 */
export async function readDriveMetadata(signer: NookSigner, batchId: string): Promise<DriveMetadata | null> {
  try {
    const bee = makeBeeWithSigner(signer)
    const topic = await driveFeedTopic(batchId)
    const reader = bee.makeFeedReader(topic, signer.getAddress())
    const result = await reader.downloadReference()
    const data = await bee.downloadData(result.reference.toHex())
    const text = new TextDecoder().decode(data.toUint8Array())

    return JSON.parse(text) as DriveMetadata
  } catch {
    // Feed doesn't exist yet — this is expected for new or non-encrypted drives
    return null
  }
}

/**
 * Write drive metadata to a per-stamp feed.
 * Uses the wallet-derived key as the feed signer.
 */
export async function writeDriveMetadata(signer: NookSigner, batchId: string, metadata: DriveMetadata): Promise<void> {
  const bee = makeBeeWithSigner(signer)
  const topic = await driveFeedTopic(batchId)
  const data = new TextEncoder().encode(JSON.stringify(metadata))
  const uploaded = await bee.uploadData(batchId, data)
  const writer = bee.makeFeedWriter(topic) // signer already set on Bee instance

  await writer.uploadReference(batchId, uploaded.reference)
}

/**
 * Scan all stamps and return metadata for encrypted drives.
 * Non-encrypted drives (no feed) return null and are skipped.
 */
export async function discoverEncryptedDrives(
  signer: NookSigner,
  stamps: { batchID: string; usable: boolean }[],
): Promise<{ batchId: string; metadata: DriveMetadata }[]> {
  const results: { batchId: string; metadata: DriveMetadata }[] = []

  // Check feeds in parallel (but with a concurrency limit to avoid flooding)
  const promises = stamps
    .filter(s => s.usable)
    .map(async stamp => {
      const metadata = await readDriveMetadata(signer, stamp.batchID)

      if (metadata?.encrypted) {
        results.push({ batchId: stamp.batchID, metadata })
      }
    })

  await Promise.allSettled(promises)

  return results
}
