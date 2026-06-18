/**
 * Pending invitations — on-chain wake-up notifications received from senders
 * who aren't yet in our contact list. Surfaced in the Messages inbox so the
 * user can accept (add as contact) and pick up the real mailbox message that
 * follows.
 *
 * Per-origin localStorage like everything else under #47.
 */

import { nsKey } from './active-identity'
import { REGISTRY_DEPLOY_BLOCK } from './constants'

export interface Invitation {
  /** Sender's lowercased ETH address */
  senderAddr: string
  /** Block number of the on-chain notification event (oldest seen) */
  blockNumber: number
  /** Unix ms when first observed locally */
  ts: number
  /** True after user adds the sender as a contact */
  processed: boolean
  /** Sender's self-claimed display name, from the (encrypted) ping payload.
   *  Unverified — shown alongside the address so the recipient knows who. */
  senderName?: string
}

const INVITATIONS_KEY = 'nook-invitations-v1'
// CURSOR_PREFIX is already explicitly scoped by myAddr at its call sites, so it
// is NOT run through nsKey (that would double-namespace it).
const CURSOR_PREFIX = 'nook-registry-cursor:'

function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)

    return raw ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}

export function loadInvitations(): Invitation[] {
  return load<Invitation[]>(nsKey(INVITATIONS_KEY), [])
}

export function saveInvitations(invs: Invitation[]): void {
  localStorage.setItem(nsKey(INVITATIONS_KEY), JSON.stringify(invs))
}

/**
 * Insert an invitation if not already present (deduped by senderAddr).
 * Keeps the OLDEST blockNumber when the same sender pings multiple times.
 */
export function addInvitation(
  invs: Invitation[],
  senderAddr: string,
  blockNumber: number,
  senderName?: string,
): Invitation[] {
  const id = senderAddr.toLowerCase()
  const existing = invs.find(i => i.senderAddr === id)

  if (existing) return invs
  const next: Invitation = { senderAddr: id, blockNumber, ts: Date.now(), processed: false, senderName }
  const updated = [...invs, next]

  saveInvitations(updated)

  return updated
}

/**
 * Drop all invitation rows for a sender. Called when the user removes the
 * sender from contacts, so a future on-chain wake-up from them surfaces as
 * a fresh invitation instead of being dedup'd against a ghost row.
 */
export function removeInvitationsFor(invs: Invitation[], senderAddr: string): Invitation[] {
  const id = senderAddr.toLowerCase()
  const updated = invs.filter(i => i.senderAddr !== id)

  saveInvitations(updated)

  return updated
}

/** Mark an invitation processed once user adds the sender as contact. */
export function markInvitationProcessed(invs: Invitation[], senderAddr: string): Invitation[] {
  const id = senderAddr.toLowerCase()
  const updated = invs.map(i => (i.senderAddr === id ? { ...i, processed: true } : i))

  saveInvitations(updated)

  return updated
}

/** Pending = not processed yet. */
export function pendingInvitations(invs: Invitation[]): Invitation[] {
  return invs.filter(i => !i.processed)
}

/**
 * Per-identity registry-poll cursor (block number we polled up to). Floored at
 * the registry's deploy block (D9): a fresh install has no cursor and must not
 * scan eth_getLogs from genesis, and Math.max also self-heals any cursor stuck
 * at 0 from an earlier build (nothing exists before the deploy block anyway).
 */
export function getRegistryCursor(myAddr: string): number {
  const raw = localStorage.getItem(CURSOR_PREFIX + myAddr.toLowerCase())

  return Math.max(Number(raw) || 0, REGISTRY_DEPLOY_BLOCK)
}

export function setRegistryCursor(myAddr: string, block: number): void {
  localStorage.setItem(CURSOR_PREFIX + myAddr.toLowerCase(), String(block))
}
