/**
 * Per-contact connection state.
 *
 * "Connection" here means: have we successfully bridged the chain layer
 * with this contact? Two pieces:
 *
 *   - Outbound bridge: we fired an on-chain registry.sendNotification so
 *     the recipient sees us as a pending invitation in their Messages app.
 *   - Inbound bridge: the contact has sent us anything (we have a mailbox
 *     message from them).
 *
 * Storage:
 *   - invite-sent timestamps live in localStorage keyed by contact id
 *   - the user's own display name (used in the default invite template
 *     and shown to recipients) lives in a single localStorage key
 *
 * Connection STATE is computed at read time from (timestamp + thread
 * contents) — not stored — so we never get out of sync with the thread
 * store.
 */

const INVITES_KEY = 'nook-invitations-sent-v1'
const MY_NAME_KEY = 'nook-my-display-name-v1'

/** 24 hours in ms — after this, the invite-sent state is shown as "stale". */
export const INVITE_STALE_MS = 24 * 60 * 60 * 1000

type InviteRecord = { sentAt: number }
type InviteMap = Record<string, InviteRecord>

function loadAll(): InviteMap {
  try {
    return JSON.parse(localStorage.getItem(INVITES_KEY) ?? '{}') as InviteMap
  } catch {
    return {}
  }
}

function saveAll(map: InviteMap): void {
  try {
    localStorage.setItem(INVITES_KEY, JSON.stringify(map))
  } catch {
    // quota / private-mode — ignore
  }
}

export function getInviteSentAt(contactId: string): number | null {
  return loadAll()[contactId.toLowerCase()]?.sentAt ?? null
}

export function recordInviteSent(contactId: string, now = Date.now()): void {
  const map = loadAll()
  map[contactId.toLowerCase()] = { sentAt: now }
  saveAll(map)
}

export function clearInviteSent(contactId: string): void {
  const map = loadAll()
  delete map[contactId.toLowerCase()]
  saveAll(map)
}

export function getMyDisplayName(): string {
  try {
    return localStorage.getItem(MY_NAME_KEY)?.trim() ?? ''
  } catch {
    return ''
  }
}

export function setMyDisplayName(name: string): void {
  const trimmed = name.trim()
  try {
    if (trimmed) localStorage.setItem(MY_NAME_KEY, trimmed)
  } catch {
    // ignore
  }
}

export type ConnectionState = 'not-connected' | 'invite-sent-fresh' | 'invite-sent-stale' | 'connected'

/**
 * Derive the connection state for a contact.
 *
 * @param contactId - the contact's ETH address
 * @param hasInbound - whether we have at least one received message in the thread
 * @param now - current timestamp (parameterizable for tests)
 */
export function deriveConnectionState(contactId: string, hasInbound: boolean, now = Date.now()): ConnectionState {
  if (hasInbound) return 'connected'
  const sentAt = getInviteSentAt(contactId)

  if (sentAt === null) return 'not-connected'

  if (now - sentAt > INVITE_STALE_MS) return 'invite-sent-stale'

  return 'invite-sent-fresh'
}

/** Default invite template — used when the user sends an invite with an empty body. */
export function defaultInviteMessage(displayName: string): string {
  return `${displayName} would like to connect`
}
