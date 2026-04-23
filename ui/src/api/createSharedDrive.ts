import { Bee, type BatchId } from '@ethersphere/bee-js'
import { ActClient, rawKeySigner } from '@nook/act-js'
import { secp256k1 } from 'ethereum-cryptography/secp256k1'
import { deriveWriteKey, driveFeedTopicHex } from '../crypto/drive'
import { writeEntry } from './driveFeed'
import type { NookSigner } from '../crypto/signer'
import type { SharedDriveV2 } from '../hooks/useSharedDrives'

export interface CreateSharedDriveArgs {
  bee: Bee
  signer: NookSigner
  creatorAddress: string
  stamp: BatchId | string
  name: string
}

export interface CreateSharedDriveResult {
  drive: SharedDriveV2
}

export async function createSharedDrive(args: CreateSharedDriveArgs): Promise<CreateSharedDriveResult> {
  const driveId = crypto.randomUUID()
  const signingKey = args.signer.getSigningKey()
  const wk = deriveWriteKey(signingKey, driveId)

  const actSigner = rawKeySigner(signingKey)
  const creatorUncompressedPub = secp256k1.getPublicKey(signingKey, false)

  const act = new ActClient({ bee: args.bee as any, stamp: args.stamp })
  const { historyRef } = await act.create({ signer: actSigner, grantees: [creatorUncompressedPub] })

  // Upload initial empty manifest
  const emptyManifest = new TextEncoder().encode(JSON.stringify({ v: 1, files: [] }))
  const manifestUpload = await args.bee.uploadData(args.stamp, emptyManifest)
  const manifestRef = manifestUpload.reference.toUint8Array()

  // Encrypt manifest ref using the creator's own ACT access key
  const encryptedRef = await act.encryptRef(manifestRef, { signer: actSigner, historyRef })

  const topicHex = driveFeedTopicHex(args.creatorAddress, driveId)
  await writeEntry({
    bee: args.bee,
    stamp: args.stamp,
    topicHex,
    writeKeyPriv: wk.privateKey,
    entry: { historyRef: bytesToHex(historyRef), encryptedRef: bytesToHex(encryptedRef) },
  })

  const drive: SharedDriveV2 = {
    driveId,
    name: args.name,
    creatorAddress: args.creatorAddress.toLowerCase(),
    myRole: 'creator',
    writeKey: bytesToHex(wk.privateKey),
    writeKeyVersion: wk.version,
    walletPublicKey: bytesToHex(args.signer.getPublicKey()),
    driveFeedTopic: topicHex,
    cachedHistoryRef: bytesToHex(historyRef),
    cachedManifestRef: bytesToHex(manifestRef),
    addedAt: Date.now(),
  }

  return { drive }
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
}
