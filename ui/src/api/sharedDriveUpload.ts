import { Bee, type BatchId } from '@ethersphere/bee-js'
import { ActClient, rawKeySigner } from '@nook/act-js'
import { secp256k1 } from 'ethereum-cryptography/secp256k1'
import { keccak_256 } from '@noble/hashes/sha3'
import { readLatestEntry, writeEntry } from './driveFeed'
import type { SharedDriveV2 } from '../hooks/useSharedDrives'

export type UploadStage =
  | 'fetching_feed'
  | 'decrypting_manifest'
  | 'uploading_file'
  | 'updating_manifest'
  | 'signing_feed'
  | 'done'

export interface UploadArgs {
  bee: Bee
  stamp: BatchId | string
  drive: SharedDriveV2
  mySigningKey: Uint8Array // NookSigner.getSigningKey()
  file: { name: string; mime: string; bytes: Uint8Array }
  onProgress?: (stage: UploadStage) => void
}

export interface UploadResult {
  fileRef: string
  newManifestRef: string
  newEncryptedRef: string
}

interface ManifestFile {
  id: string
  name: string
  ref: string
  size: number
  mime: string
  uploadedAt: number
}

export async function uploadToSharedDrive(args: UploadArgs): Promise<UploadResult> {
  const { bee, stamp, drive, mySigningKey, file, onProgress } = args

  if (!drive.writeKey) throw new Error('uploadToSharedDrive: writeKey missing (reader-only drive)')
  if (!drive.walletPublicKey) throw new Error('uploadToSharedDrive: creator walletPublicKey missing')

  const writeKeyPriv = hexToBytes(drive.writeKey)
  // Derive the feed owner address from the writeKey private key
  const writeKeyPub = secp256k1.getPublicKey(writeKeyPriv, false) // uncompressed
  const addrBytes = keccak_256(writeKeyPub.slice(1))
  const ownerAddress = '0x' + bytesToHex(addrBytes.slice(-20))

  const creatorPub = secp256k1.ProjectivePoint.fromHex(drive.walletPublicKey).toRawBytes(false)
  const mySigner = rawKeySigner(mySigningKey)
  const act = new ActClient({ bee: bee as any, stamp })

  onProgress?.('fetching_feed')
  const latest = await readLatestEntry({ bee, topicHex: drive.driveFeedTopic, ownerAddress })
  if (!latest) throw new Error('uploadToSharedDrive: drive feed is empty')

  const historyRef = hexToBytes(latest.historyRef)
  const encryptedRef = hexToBytes(latest.encryptedRef)

  onProgress?.('decrypting_manifest')
  const manifestRef = await act.decryptRef(encryptedRef, {
    signer: mySigner,
    publisherPub: creatorPub,
    historyRef,
  })

  const manifestData = await bee.downloadData(manifestRef)
  const manifest = JSON.parse(
    new TextDecoder().decode(manifestData.toUint8Array()),
  ) as { v: 1; files: ManifestFile[] }

  onProgress?.('uploading_file')
  const fileUpload = await bee.uploadData(stamp, file.bytes)
  const fileRef = fileUpload.reference.toUint8Array()

  onProgress?.('updating_manifest')
  manifest.files.push({
    id: crypto.randomUUID(),
    name: file.name,
    ref: bytesToHex(fileRef),
    size: file.bytes.length,
    mime: file.mime,
    uploadedAt: Date.now(),
  })

  const newManifestBytes = new TextEncoder().encode(JSON.stringify(manifest))
  const newManifestUpload = await bee.uploadData(stamp, newManifestBytes)
  const newManifestRef = newManifestUpload.reference.toUint8Array()

  // Re-encrypt under the same historyRef (historyRef does not change on uploads)
  const newEncryptedRef = await act.reencryptRef(newManifestRef, {
    signer: mySigner,
    publisherPub: creatorPub,
    historyRef,
  })

  onProgress?.('signing_feed')
  await writeEntry({
    bee,
    stamp,
    topicHex: drive.driveFeedTopic,
    writeKeyPriv,
    entry: {
      historyRef: latest.historyRef,
      encryptedRef: bytesToHex(newEncryptedRef),
      memberListRef: latest.memberListRef,
    },
  })

  onProgress?.('done')
  return {
    fileRef: bytesToHex(fileRef),
    newManifestRef: bytesToHex(newManifestRef),
    newEncryptedRef: bytesToHex(newEncryptedRef),
  }
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex
  const out = new Uint8Array(clean.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16)
  return out
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
}
