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

/** Sender's contact info embedded in a drive-share link. */
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
 * Optional contact bundle: addr + wpub + bpub (+ optional name).
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
    const bpub = params.get('bpub')
    const name = params.get('name') ?? undefined
    const sender = addr && wpub && bpub ? { addr, walletPublicKey: wpub, beePublicKey: bpub, name } : undefined

    return { feedTopic, feedOwner, actPublisher, sender }
  } catch {
    return null
  }
}

/** Build a share link. Throws if any required field is missing. */
export function buildShareLink(args: {
  feedTopic: string
  feedOwner: string
  actPublisher: string
  sender: SenderContactInfo
}): string {
  const params = new URLSearchParams({
    topic: args.feedTopic,
    owner: args.feedOwner,
    publisher: args.actPublisher,
    addr: args.sender.addr,
    wpub: args.sender.walletPublicKey,
    bpub: args.sender.beePublicKey,
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
