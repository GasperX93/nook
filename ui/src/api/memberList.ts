import { Bee, type BatchId } from '@ethersphere/bee-js'
import { keccak_256 } from '@noble/hashes/sha3'
import { secp256k1 } from 'ethereum-cryptography/secp256k1'
import type { NookSigner } from '../crypto/signer'
import type { SharedDriveV2 } from '../hooks/useSharedDrives'

export type MemberRole = 'creator' | 'writer' | 'reader'

export interface MemberEntry {
  ethAddress: string
  role: MemberRole
  addedAt: number
  walletPublicKey?: string // compressed hex, cached for convenience
}

export interface MemberListDoc {
  v: 1
  driveId: string
  creatorAddress: string
  writeKeyVersion: number
  updatedAt: number
  members: MemberEntry[]
  signature: string // 65-byte hex: r(32) + s(32) + v(1)
}

/** Stable canonical JSON for signing — deterministic key order + sorted members. */
function canonicalJson(doc: Omit<MemberListDoc, 'signature'>): string {
  const { v, driveId, creatorAddress, writeKeyVersion, updatedAt, members } = doc
  const sortedMembers = [...members].sort((a, b) => a.ethAddress.localeCompare(b.ethAddress))

  return JSON.stringify({ v, driveId, creatorAddress, writeKeyVersion, updatedAt, members: sortedMembers })
}

export async function signMemberList(
  doc: Omit<MemberListDoc, 'signature'>,
  signer: NookSigner,
): Promise<MemberListDoc> {
  const digest = keccak_256(new TextEncoder().encode(canonicalJson(doc)))
  const sig = secp256k1.sign(digest, signer.getSigningKey())
  const sigBytes = new Uint8Array(65)
  sigBytes.set(sig.toCompactRawBytes(), 0)
  sigBytes[64] = sig.recovery ?? 0

  return { ...doc, signature: bytesToHex(sigBytes) }
}

export function verifyMemberList(doc: MemberListDoc, expectedCreatorPub: Uint8Array): boolean {
  try {
    const { signature: _sig, ...rest } = doc
    const digest = keccak_256(new TextEncoder().encode(canonicalJson(rest as Omit<MemberListDoc, 'signature'>)))
    const sigBytes = hexToBytes(doc.signature)
    const sig = secp256k1.Signature.fromCompact(sigBytes.slice(0, 64)).addRecoveryBit(sigBytes[64])
    const recoveredPub = sig.recoverPublicKey(digest).toRawBytes(false)

    return equalBytes(recoveredPub, expectedCreatorPub)
  } catch {
    return false
  }
}

export interface UpdateMemberListArgs {
  bee: Bee
  stamp: BatchId | string
  drive: SharedDriveV2
  signer: NookSigner
  change:
    | { add: MemberEntry }
    | { remove: { ethAddress: string } }
    | { updateRole: { ethAddress: string; role: MemberRole } }
}

export interface UpdateMemberListResult {
  ref: Uint8Array
  doc: MemberListDoc
}

export async function updateMemberList(args: UpdateMemberListArgs): Promise<UpdateMemberListResult> {
  const current = args.drive.cachedMemberListRef
    ? await fetchMemberList(args.bee, hexToBytes(args.drive.cachedMemberListRef))
    : null

  const seed: MemberEntry = { ethAddress: args.drive.creatorAddress, role: 'creator', addedAt: Date.now() }
  let newMembers: MemberEntry[] = current?.members ?? [seed]

  const change = args.change

  if ('add' in change) {
    newMembers = newMembers.filter(m => m.ethAddress !== change.add.ethAddress)
    newMembers.push(change.add)
  } else if ('remove' in change) {
    newMembers = newMembers.filter(m => m.ethAddress !== change.remove.ethAddress)
  } else if ('updateRole' in change) {
    newMembers = newMembers.map(m =>
      m.ethAddress === change.updateRole.ethAddress ? { ...m, role: change.updateRole.role } : m,
    )
  }

  const doc = await signMemberList(
    {
      v: 1,
      driveId: args.drive.driveId,
      creatorAddress: args.drive.creatorAddress,
      writeKeyVersion: args.drive.writeKeyVersion,
      updatedAt: Date.now(),
      members: newMembers,
    },
    args.signer,
  )

  const bytes = new TextEncoder().encode(JSON.stringify(doc))
  const upload = await args.bee.uploadData(args.stamp, bytes)

  return { ref: upload.reference.toUint8Array(), doc }
}

export async function fetchMemberList(bee: Bee, ref: Uint8Array): Promise<MemberListDoc | null> {
  try {
    const data = await bee.downloadData(ref)

    return JSON.parse(new TextDecoder().decode(data.toUint8Array())) as MemberListDoc
  } catch {
    return null
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

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false

  return a.every((v, i) => v === b[i])
}
