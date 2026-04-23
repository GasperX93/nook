/**
 * Shared drives — drives other users have shared with you via share links.
 * Stored in localStorage. Read-only (you can download but not upload).
 *
 * Legacy drives use STORAGE_KEY ('nook-shared-drives').
 * V2 ACT-backed drives use STORAGE_KEY_V2 ('nook-shared-drives-v2').
 */
import { useState } from 'react'

const STORAGE_KEY = 'nook-shared-drives'
const STORAGE_KEY_V2 = 'nook-shared-drives-v2'

export interface SharedFile {
  name: string
  reference: string
  historyRef: string
  size: number
}

export interface SharedDrive {
  id: string
  name: string
  reference: string
  actPublisher: string
  actHistoryRef: string
  addedAt: number
  files?: SharedFile[]
  fromLabel?: string
  /** Feed-based sharing (live file list) */
  feedTopic?: string
  feedOwner?: string
}

function load(): SharedDrive[] {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]')
  } catch {
    return []
  }
}

function persist(drives: SharedDrive[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(drives))
}

/**
 * Sender's contact info derived from a drive-share link.
 * `beePublicKey` is reconstructed from the link's `publisher` field — no
 * separate `bpub` is carried in the URL (it'd duplicate `publisher`).
 */
export interface SenderContactInfo {
  addr: string
  walletPublicKey: string
  beePublicKey: string
  name?: string
}

export interface ParsedShareLink {
  feedTopic: string
  feedOwner: string
  actPublisher: string
  /** Present when sender bundled contact info in the link. */
  sender?: SenderContactInfo
}

// ─── V2 shared drive types ─────────────────────────────────────────────────

export type DriveRole = 'creator' | 'writer' | 'reader'

/** V2 ACT-backed shared drive record stored in nook-shared-drives-v2. */
export interface SharedDriveV2 {
  driveId: string
  name: string
  creatorAddress: string
  myRole: DriveRole
  writeKey?: string // hex 32-byte private key (creator + writers only)
  writeKeyVersion: number
  walletPublicKey?: string // creator's compressed-hex pubkey (for ACT + ECIES)
  driveFeedTopic: string // hex 32-byte topic
  cachedHistoryRef?: string
  cachedManifestRef?: string
  cachedMemberListRef?: string
  addedAt: number
  lastSyncAt?: number
}

function loadV2(): SharedDriveV2[] {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY_V2) ?? '[]')
  } catch {
    return []
  }
}

function persistV2(drives: SharedDriveV2[]) {
  localStorage.setItem(STORAGE_KEY_V2, JSON.stringify(drives))
}

export function useSharedDrivesV2() {
  const [drives, setDrives] = useState<SharedDriveV2[]>(loadV2)

  function addDrive(drive: SharedDriveV2) {
    setDrives(prev => {
      if (prev.some(d => d.driveId === drive.driveId)) return prev
      const next = [...prev, drive]
      persistV2(next)

      return next
    })
  }

  function updateDrive(driveId: string, patch: Partial<SharedDriveV2>) {
    setDrives(prev => {
      const next = prev.map(d => (d.driveId === driveId ? { ...d, ...patch } : d))
      persistV2(next)

      return next
    })
  }

  function removeDrive(driveId: string) {
    setDrives(prev => {
      const next = prev.filter(d => d.driveId !== driveId)
      persistV2(next)

      return next
    })
  }

  function getDrive(driveId: string): SharedDriveV2 | undefined {
    return drives.find(d => d.driveId === driveId)
  }

  return { drives, addDrive, updateDrive, removeDrive, getDrive }
}

// ─── Share link parsing (v1 legacy + v2) ───────────────────────────────────

export interface ParsedShareLinkV1 extends ParsedShareLink {
  type: 'nook-drive-share-v1'
}

export interface ParsedShareLinkV2 {
  type: 'nook-drive-share-v2'
  driveId: string
  creatorAddress: string
  driveFeedTopic: string
  walletPublicKey: string
  writeKeyVersion: number
  name: string
  role: 'reader' | 'writer'
  writeKeyBlob?: string
  sender?: SenderContactInfo
}

export type ParsedShareLinkTyped = ParsedShareLinkV1 | ParsedShareLinkV2

/**
 * Parse a `nook://drive-share?...` link.
 * Returns typed discriminated union: v2 (has driveId) or v1 legacy.
 */
export function parseShareLinkTyped(link: string): ParsedShareLinkTyped | null {
  try {
    const trimmed = link.trim()
    const NOOK_PREFIX = 'nook://drive-share?'

    if (!trimmed.startsWith(NOOK_PREFIX)) return null
    const params = new URLSearchParams(trimmed.slice(NOOK_PREFIX.length))

    const driveId = params.get('driveId')

    if (driveId) {
      const creator = params.get('creator')?.toLowerCase()
      const topic = params.get('topic')
      const pub = params.get('pub')

      if (!creator || !topic || !pub) return null
      const version = parseInt(params.get('version') ?? '1', 10)
      const name = decodeURIComponent(params.get('name') ?? '')
      const role = (params.get('role') ?? 'reader') as 'reader' | 'writer'
      const writeKeyBlob = params.get('writeKey') ?? undefined
      const addr = params.get('addr')
      const wpub = params.get('wpub')
      const sender = addr && wpub ? { addr, walletPublicKey: wpub, beePublicKey: pub, name: undefined } : undefined

      return {
        type: 'nook-drive-share-v2',
        driveId,
        creatorAddress: creator,
        driveFeedTopic: topic,
        walletPublicKey: pub,
        writeKeyVersion: version,
        name,
        role,
        writeKeyBlob,
        sender,
      }
    }

    // v1 legacy
    const feedTopic = params.get('topic')
    const feedOwner = params.get('owner')
    const actPublisher = params.get('publisher')

    if (!feedTopic || !feedOwner || !actPublisher) return null
    const addr = params.get('addr')
    const wpub = params.get('wpub')
    const name = params.get('name') ?? undefined
    const sender = addr && wpub ? { addr, walletPublicKey: wpub, beePublicKey: actPublisher, name } : undefined

    return { type: 'nook-drive-share-v1', feedTopic, feedOwner, actPublisher, sender }
  } catch {
    return null
  }
}

export function buildV2ShareLink(
  drive: SharedDriveV2,
  role: 'reader' | 'writer',
  writeKeyBlob?: Uint8Array,
  sender?: { addr: string; walletPublicKey: string },
): string {
  const params = new URLSearchParams({
    driveId: drive.driveId,
    creator: drive.creatorAddress,
    topic: drive.driveFeedTopic,
    pub: drive.walletPublicKey!,
    version: String(drive.writeKeyVersion),
    name: drive.name,
    role,
  })

  if (role === 'writer' && writeKeyBlob) params.set('writeKey', bytesToHex(writeKeyBlob))

  if (sender) {
    params.set('addr', sender.addr)
    params.set('wpub', sender.walletPublicKey)
  }

  return `nook://drive-share?${params.toString()}`
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
}

/**
 * Parse a `nook://drive-share?...` link.
 * Required params: topic, owner, publisher.
 * Optional contact bundle: addr + wpub (+ optional name).
 * `publisher` doubles as the sender's Bee pubkey when contact info is present.
 *
 * Legacy `swarm://feed?...` links are NOT accepted — pre-release schema break.
 */
export function parseShareLink(link: string): ParsedShareLink | null {
  try {
    const trimmed = link.trim()
    const NOOK_PREFIX = 'nook://drive-share?'

    if (!trimmed.startsWith(NOOK_PREFIX)) return null
    const params = new URLSearchParams(trimmed.slice(NOOK_PREFIX.length))
    const feedTopic = params.get('topic')
    const feedOwner = params.get('owner')
    const actPublisher = params.get('publisher')

    if (!feedTopic || !feedOwner || !actPublisher) return null

    const addr = params.get('addr')
    const wpub = params.get('wpub')
    const name = params.get('name') ?? undefined
    const sender = addr && wpub ? { addr, walletPublicKey: wpub, beePublicKey: actPublisher, name } : undefined

    return { feedTopic, feedOwner, actPublisher, sender }
  } catch {
    return null
  }
}

/**
 * Build a share link. The sender's `beePublicKey` MUST equal `actPublisher` —
 * the link only encodes it once via `publisher`.
 */
export function buildShareLink(args: {
  feedTopic: string
  feedOwner: string
  actPublisher: string
  sender: Omit<SenderContactInfo, 'beePublicKey'>
}): string {
  const params = new URLSearchParams({
    topic: args.feedTopic,
    owner: args.feedOwner,
    publisher: args.actPublisher,
    addr: args.sender.addr,
    wpub: args.sender.walletPublicKey,
  })

  if (args.sender.name) params.set('name', args.sender.name)

  return `nook://drive-share?${params.toString()}`
}

export function useSharedDrives() {
  const [drives, setDrives] = useState<SharedDrive[]>(load)

  function add(drive: Omit<SharedDrive, 'id' | 'addedAt'>) {
    const newDrive: SharedDrive = {
      ...drive,
      id: crypto.randomUUID(),
      addedAt: Date.now(),
    }

    setDrives(prev => {
      const next = [...prev, newDrive]

      persist(next)

      return next
    })

    return newDrive
  }

  function remove(id: string) {
    setDrives(prev => {
      const next = prev.filter(d => d.id !== id)

      persist(next)

      return next
    })
  }

  function reload() {
    setDrives(load())
  }

  return { drives, add, remove, reload }
}
