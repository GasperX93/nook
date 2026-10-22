import { type ContactBackup, serverApi } from '../api/server'
import { getActiveIdentity } from './active-identity'
import { CONTACTS_RESTORED_EVENT, onContactDataChanged } from './backup-signal'
import {
  getMyDisplayName,
  loadInvitesAccepted,
  loadInvitesSent,
  mergeInviteState,
  setMyDisplayName,
} from './contact-state'
import { advanceSendCursor, loadReadCursors, loadSendCursors, saveReadCursors } from './messages'
import { noteContactsRestored } from './other-browser'
import { hasReadCursor, positionsToKeep, raiseExpected } from './receive-cursor'
import { loadContacts, saveContacts } from './storage'
import type { NookContact } from './types'

/**
 * Contacts in the app folder (#192). localStorage is per browser and profile,
 * so another browser or cleared site data showed an empty contact list. On
 * sign-in the saved copy is merged in; after that every change is saved again.
 *
 * Merge never deletes: contacts are added by address, send cursors and read
 * positions of their feeds take the higher index, read marks the later time (so restored messages you already
 * read don't show as unread), the name fills in only when this browser has none. Nothing is
 * saved before the saved copy was read, so an empty browser can't overwrite it.
 */

const SAVE_DELAY_MS = 500

/** The identity whose saved copy has been merged in — saving is allowed only for it. */
let restoredFor: string | null = null
let saveTimer: ReturnType<typeof setTimeout> | null = null

export function mergeContacts(local: NookContact[], saved: NookContact[]): NookContact[] {
  const known = new Set(local.map(c => c.id.toLowerCase()))
  const added = saved.filter(c => c && typeof c.id === 'string' && !known.has(c.id.toLowerCase()))

  return [...local, ...added.map(c => ({ ...c, id: c.id.toLowerCase() }))]
}

function snapshot(): ContactBackup {
  return {
    contacts: loadContacts(),
    sendCursors: loadSendCursors(),
    readMarks: loadReadCursors(),
    theirNext: positionsToKeep(),
    invitesSent: loadInvitesSent(),
    invitesAccepted: loadInvitesAccepted(),
    myName: getMyDisplayName(),
  }
}

async function save(address: string): Promise<void> {
  if (restoredFor !== address || getActiveIdentity() !== address) return
  try {
    await serverApi.writeContactBackup(address, snapshot())
  } catch {
    // Server unreachable — the next change saves again.
  }
}

function scheduleSave(): void {
  const address = getActiveIdentity()

  if (!address || restoredFor !== address) return

  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    saveTimer = null
    void save(address)
  }, SAVE_DELAY_MS)
}

onContactDataChanged(scheduleSave)

/**
 * Merge the saved copy into this browser for the active identity, then save
 * the result (so contacts only this browser had are saved too). Call after
 * setActiveIdentity; a no-op when the identity changed meanwhile.
 */
export async function restoreContactBackup(address: string): Promise<void> {
  const id = address.toLowerCase()

  restoredFor = null
  let saved: ContactBackup | null

  try {
    saved = (await serverApi.readContactBackup(id)).backup
  } catch {
    // Can't read it — don't save either, or an empty browser could replace it.
    return
  }

  if (getActiveIdentity() !== id) return

  if (saved) {
    // Positions first, so a restored contact is never shown before the
    // conversation knows what it is waiting for (#191).
    for (const [counterparty, next] of Object.entries(saved.sendCursors ?? {})) {
      if (Number.isInteger(next) && next > 0) advanceSendCursor(counterparty, next - 1)
    }
    // Only where this browser hasn't read that conversation itself: a browser
    // with its own read position never waits for another browser's.
    raiseExpected(
      Object.fromEntries(Object.entries(saved.theirNext ?? {}).filter(([contactId]) => !hasReadCursor(contactId))),
    )
    mergeInviteState(saved.invitesSent ?? {}, saved.invitesAccepted ?? {})

    const marks = loadReadCursors()
    let marksChanged = false

    for (const [counterparty, ts] of Object.entries(saved.readMarks ?? {})) {
      if (Number.isFinite(ts) && ts > (marks[counterparty] ?? 0)) {
        marks[counterparty] = ts
        marksChanged = true
      }
    }

    if (marksChanged) saveReadCursors(marks)

    if (!getMyDisplayName() && typeof saved.myName === 'string') setMyDisplayName(saved.myName)

    const local = loadContacts()
    const merged = mergeContacts(local, Array.isArray(saved.contacts) ? saved.contacts : [])

    if (merged.length !== local.length) {
      saveContacts(merged)
      window.dispatchEvent(new Event(CONTACTS_RESTORED_EVENT))
      noteContactsRestored()
    }
  }
  restoredFor = id
  await save(id)
}
