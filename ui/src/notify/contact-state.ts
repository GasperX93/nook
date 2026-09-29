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

import { nsKey } from './active-identity'

const INVITES_KEY = 'nook-invitations-sent-v1'
const MY_NAME_KEY = 'nook-my-display-name-v1'

/** 24 hours in ms — after this, the invite-sent state is shown as "stale". */
export const INVITE_STALE_MS = 24 * 60 * 60 * 1000

type InviteRecord = { sentAt: number }
type InviteMap = Record<string, InviteRecord>

function loadAll(): InviteMap {
  try {
    return JSON.parse(localStorage.getItem(nsKey(INVITES_KEY)) ?? '{}') as InviteMap
  } catch {
    return {}
  }
}

function saveAll(map: InviteMap): void {
  try {
    localStorage.setItem(nsKey(INVITES_KEY), JSON.stringify(map))
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
    return localStorage.getItem(nsKey(MY_NAME_KEY))?.trim() ?? ''
  } catch {
    return ''
  }
}

export function setMyDisplayName(name: string): void {
  const trimmed = name.trim()
  try {
    if (trimmed) localStorage.setItem(nsKey(MY_NAME_KEY), trimmed)
  } catch {
    // ignore
  }
}

export type ConnectionState = 'not-connected' | 'invite-sent-fresh' | 'invite-sent-stale' | 'connected'

const ACCEPTED_KEY = 'nook-accepted-invites'

function loadAccepted(): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(nsKey(ACCEPTED_KEY)) ?? '{}')
  } catch {
    return {}
  }
}

/**
 * Record that WE accepted this contact's invitation (#14). Accepting proves
 * the peer initiated — the relationship is established even before their
 * first regular message lands, so the composer must not fall into the
 * invite path (which would send a redundant "would like to connect" bubble
 * plus a pointless paid on-chain ping into an already-connected thread).
 */
export function markInviteAccepted(contactId: string): void {
  try {
    const map = loadAccepted()

    map[contactId.toLowerCase()] = Date.now()
    localStorage.setItem(nsKey(ACCEPTED_KEY), JSON.stringify(map))
  } catch {
    // storage unavailable — worst case the composer offers an invite once
  }
}

/** Forget that we accepted this contact's invitation — used when the contact is deleted (R3b-3). */
export function clearInviteAccepted(contactId: string): void {
  try {
    const map = loadAccepted()

    delete map[contactId.toLowerCase()]
    localStorage.setItem(nsKey(ACCEPTED_KEY), JSON.stringify(map))
  } catch {
    // storage unavailable — ignore
  }
}

/**
 * Whether the thread holds a message FROM this contact received since they
 * were (re-)added. Deleting a contact keeps the thread history, so without the
 * cut-off a re-added contact looks connected off old messages and the invite
 * (with its on-chain ping) never fires (R3b-3). Received `ts` is the sender's
 * timestamp; contacts saved without `addedAt` count every message.
 */
export function hasInboundSince(thread: { direction: 'sent' | 'received'; ts: number }[], addedAt?: number): boolean {
  return thread.some(m => m.direction === 'received' && m.ts >= (addedAt ?? 0))
}

export function wasInviteAccepted(contactId: string): boolean {
  return contactId.toLowerCase() in loadAccepted()
}

/**
 * Derive the connection state for a contact.
 *
 * @param contactId - the contact's ETH address
 * @param hasInbound - whether we have at least one received message in the thread
 * @param now - current timestamp (parameterizable for tests)
 */
export function deriveConnectionState(contactId: string, hasInbound: boolean, now = Date.now()): ConnectionState {
  // Accepting their invitation establishes the connection (#14) — don't wait
  // for their first regular message to flip the composer out of invite mode.
  if (hasInbound || wasInviteAccepted(contactId)) return 'connected'
  const sentAt = getInviteSentAt(contactId)

  if (sentAt === null) return 'not-connected'

  if (now - sentAt > INVITE_STALE_MS) return 'invite-sent-stale'

  return 'invite-sent-fresh'
}

/** Default invite template — used when the user sends an invite with an empty body. */
export function defaultInviteMessage(displayName: string): string {
  return `${displayName} would like to connect`
}
