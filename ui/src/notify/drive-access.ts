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

  for (const m of [...messages].sort((a, b) => a.ts - b.ts)) {
    if (m.direction !== 'received' || !m.kind || m.kind === 'message') continue
    const target = findSharedDriveForLink(m.driveShareLink)

    if (!target) continue
    const i = drives.findIndex(d => d.id === target.id)
    const name = m.driveName || target.name

    if (m.kind === 'drive-access-removed') {
      if ((drives[i].revokedAt ?? 0) >= m.ts) continue
      drives[i] = { ...drives[i], revokedAt: m.ts, syncRequestedAt: undefined }
      changed = true
      void serverApi
        .createNotification({
          type: 'info',
          title: 'Access removed',
          body: `${senderName} removed your access to “${name}”.`,
          link: '/drive?tab=shared',
        })
        .catch(() => undefined)
    } else {
      const wasRevoked = drives[i].revokedAt !== undefined
      drives[i] = { ...drives[i], revokedAt: undefined, syncRequestedAt: m.ts }
      changed = true

      if (wasRevoked || m.kind === 'drive-access-restored') {
        void serverApi
          .createNotification({
            type: 'info',
            title: 'Access restored',
            body: `${senderName} gave you access to “${name}” again.`,
            link: '/drive?tab=shared',
          })
          .catch(() => undefined)
      }
    }
  }

  if (!changed) return
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(drives))
  } catch {
    return
  }
  window.dispatchEvent(new Event(SHARED_DRIVES_CHANGED))
}
