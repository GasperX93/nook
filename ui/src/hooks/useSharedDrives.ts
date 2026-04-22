/**
 * Shared drives — drives other users have shared with you via share links.
 * Stored in localStorage. Read-only (you can download but not upload).
 */
import { useState } from 'react'

const STORAGE_KEY = 'nook-shared-drives'

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
