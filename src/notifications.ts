import { existsSync, readFileSync, writeFileSync } from 'fs'
import { randomUUID } from 'crypto'

import { logger } from './logger'
import { createNotification } from './notify'
import { getPath } from './path'

/**
 * Notification store (#138) — the permanent event feed behind the bell.
 *
 * States vs. events: ongoing conditions (node down, charge blocked) are
 * BANNERS, computed live and gone when resolved. This store holds EVENTS —
 * things that happened or are scheduled — because an app that spends money
 * on the user's behalf (#129) owes them a record that survives restarts and
 * can't be un-happened. A failed charge is deliberately both: an event here,
 * a banner until fixed.
 *
 * Server-side because money events originate in the tray process while the
 * dashboard is closed, and because event creation is also where the native
 * desktop notification fires — the only channel that reaches a user who
 * hasn't opened the app. Clients may also post events (future types like
 * connection requests) so everything shares one history.
 */

export type NotificationType =
  | 'upcoming-charge'
  | 'charge-executed'
  | 'charge-blocked'
  | 'chequebook-funded'
  // Client-posted types (accepted via POST /notifications; none emitted yet)
  | 'connection-request'
  | 'connection-accepted'
  | 'info'

const KNOWN_TYPES: NotificationType[] = [
  'upcoming-charge',
  'charge-executed',
  'charge-blocked',
  'chequebook-funded',
  'connection-request',
  'connection-accepted',
  'info',
]

export interface NookNotification {
  id: string
  type: NotificationType
  title: string
  body: string
  /** Unix ms */
  createdAt: number
  /** Unix ms — absent while unread */
  readAt?: number
  /** In-app deep link, e.g. '/drive' */
  link?: string
  /** Structured payload for consumers (e.g. the wallet Activity list, #139) */
  data?: Record<string, string | number>
}

/** History cap — the bell is a record, not an archive. Oldest entries drop. */
const MAX_NOTIFICATIONS = 50

const STORE_FILE = 'notifications.json'

function storePath(): string {
  return getPath(STORE_FILE)
}

export function loadNotifications(): NookNotification[] {
  try {
    if (!existsSync(storePath())) return []
    const data = JSON.parse(readFileSync(storePath(), 'utf-8')) as NookNotification[]

    return Array.isArray(data) ? data : []
  } catch (error) {
    logger.error(`notification store unreadable: ${error}`)

    return []
  }
}

function save(notifications: NookNotification[]): void {
  writeFileSync(storePath(), JSON.stringify(notifications, null, 2))
}

export interface PushOptions {
  type: NotificationType
  title: string
  body: string
  link?: string
  data?: Record<string, string | number>
  /**
   * Fire a native desktop notification on creation. True for money events
   * (charges — the user must be reachable with the app closed); false for
   * internal rebalancing like chequebook deposits, which the bell records
   * without interrupting anyone.
   */
  desktop?: boolean
}

export function pushNotification(options: PushOptions): NookNotification {
  if (!KNOWN_TYPES.includes(options.type)) {
    throw new Error(`Unknown notification type: ${options.type}`)
  }
  const title = options.title.slice(0, 120)
  const body = options.body.slice(0, 500)

  const notification: NookNotification = {
    id: randomUUID(),
    type: options.type,
    title,
    body,
    createdAt: Date.now(),
    ...(options.link ? { link: options.link } : {}),
    ...(options.data ? { data: options.data } : {}),
  }

  // Newest first; cap drops the oldest.
  const updated = [notification, ...loadNotifications()].slice(0, MAX_NOTIFICATIONS)

  save(updated)
  logger.info(`notification: [${notification.type}] ${title}`)

  if (options.desktop) {
    try {
      createNotification(`${title} — ${body}`)
    } catch (error) {
      // Desktop notifications are best-effort (OS permission, headless CI).
      logger.info(`desktop notification failed: ${error}`)
    }
  }

  return notification
}

/** Mark the given ids read (all unread when ids is undefined). */
export function markNotificationsRead(ids?: string[]): number {
  const now = Date.now()
  let changed = 0
  const updated = loadNotifications().map(n => {
    if (n.readAt === undefined && (ids === undefined || ids.includes(n.id))) {
      changed += 1

      return { ...n, readAt: now }
    }

    return n
  })

  if (changed > 0) save(updated)

  return changed
}
