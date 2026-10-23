/**
 * Apply incoming drive messages to "Shared with me" (R4-15/16), so a removal
 * or restore reaches the recipient on the mailbox poll (~30 s, any page)
 * instead of waiting for a manual sync.
 *
 * - drive-access-removed → mark the drive revoked (the card shows "Access removed")
 * - drive-access-restored, or a plain drive-share for a drive we already have
 *   → clear the revoked mark and request a sync (the card re-reads the feed)
 *
 * Shared drives are matched by feed identity (topic + owner) — the same key
 * useSharedDrives dedupes on. A message for a drive we don't have is ignored
 * here; its card still offers "Add drive".
 */
import { serverApi } from '../api/server'
import { parseShareLink, type SharedDrive } from '../hooks/useSharedDrives'
import { type DriveOp, sendDriveOps, toPatch } from '../store/drive-data'
import type { StoredMessage } from './messages'

const STORAGE_KEY = 'nook-shared-drives'
export const SHARED_DRIVES_CHANGED = 'nook:shared-drives-changed'

function load(): SharedDrive[] {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]') as SharedDrive[]
  } catch {
    return []
  }
}

/** Compare hex ids regardless of case or a 0x prefix (stored entries vary). */
function hexKey(v: string): string {
  return v.toLowerCase().replace(/^0x/, '')
}

/** The "Shared with me" entry a drive link points at, if we have it. */
export function findSharedDriveForLink(link: string | undefined): SharedDrive | undefined {
  const parsed = link ? parseShareLink(link) : null

  if (!parsed) return undefined

  const same = (a: string | undefined, b: string) => a !== undefined && hexKey(a) === hexKey(b)

  return load().find(d => same(d.feedTopic, parsed.feedTopic) && same(d.feedOwner, parsed.feedOwner))
}

export function applyDriveMessages(messages: StoredMessage[], senderName: string): void {
  const drives = load()
  let changed = false
  // The same changes for the app's copy (store/drive-data), one patch per drive.
  const changes = new Map<string, Record<string, unknown>>()
  const change = (id: string, fields: Partial<SharedDrive>) => changes.set(id, { ...changes.get(id), ...fields })
  // Notify only when a drive's access really changed in this batch. A new
  // browser reads every conversation from the start: replaying old removals
  // and restores ends where the app's copy already was, and used to ring the
  // bell for each of them as if it had just happened.
  const revokedBefore = new Map(drives.map(d => [d.id, d.revokedAt !== undefined]))
  const names = new Map<string, string>()

  for (const m of [...messages].sort((a, b) => a.ts - b.ts)) {
    if (m.direction !== 'received' || !m.kind || m.kind === 'message') continue
    const target = findSharedDriveForLink(m.driveShareLink)

    if (!target) continue
    const i = drives.findIndex(d => d.id === target.id)
    const name = m.driveName || target.name

    if (m.kind === 'drive-access-removed') {
      if ((drives[i].revokedAt ?? 0) >= m.ts) continue
      drives[i] = { ...drives[i], revokedAt: m.ts, syncRequestedAt: undefined }
      change(drives[i].id, { revokedAt: m.ts, syncRequestedAt: undefined })
    } else {
      drives[i] = { ...drives[i], revokedAt: undefined, syncRequestedAt: m.ts }
      change(drives[i].id, { revokedAt: undefined, syncRequestedAt: m.ts })
    }
    names.set(drives[i].id, name)
    changed = true
  }

  if (!changed) return
  for (const d of drives) {
    const before = revokedBefore.get(d.id)
    const now = d.revokedAt !== undefined

    if (!changes.has(d.id) || before === now) continue
    void serverApi
      .createNotification({
        type: 'info',
        title: now ? 'Access removed' : 'Access restored',
        body: now
          ? `${senderName} removed your access to “${names.get(d.id)}”.`
          : `${senderName} gave you access to “${names.get(d.id)}” again.`,
        link: '/drive?tab=shared',
      })
      .catch(() => undefined)
  }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(drives))
  } catch {
    return
  }
  sendDriveOps(
    [...changes].map(([id, fields]): DriveOp => ({ kind: 'shared', op: 'patch', id, changes: toPatch(fields) })),
  )
  window.dispatchEvent(new Event(SHARED_DRIVES_CHANGED))
}
