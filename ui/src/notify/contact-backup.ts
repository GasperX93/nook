import { type ContactBackup, serverApi } from '../api/server'
import { getActiveIdentity } from './active-identity'
import { CONTACTS_RESTORED_EVENT, onContactDataChanged } from './backup-signal'
import { getMyDisplayName, setMyDisplayName } from './contact-state'
import { advanceSendCursor, loadSendCursors } from './messages'
import { loadContacts, saveContacts } from './storage'
import type { NookContact } from './types'

/**
 * Contacts in the app folder (#192). localStorage is per browser and profile,
 * so another browser or cleared site data showed an empty contact list. On
 * sign-in the saved copy is merged in; after that every change is saved again.
 *
 * Merge never deletes: contacts are added by address, send cursors take the
 * higher index, the name fills in only when this browser has none. Nothing is
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
  return { contacts: loadContacts(), sendCursors: loadSendCursors(), myName: getMyDisplayName() }
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
    const local = loadContacts()
    const merged = mergeContacts(local, Array.isArray(saved.contacts) ? saved.contacts : [])

    if (merged.length !== local.length) saveContacts(merged)

    for (const [counterparty, next] of Object.entries(saved.sendCursors ?? {})) {
      if (Number.isInteger(next) && next > 0) advanceSendCursor(counterparty, next - 1)
    }

    if (!getMyDisplayName() && typeof saved.myName === 'string') setMyDisplayName(saved.myName)

    if (merged.length !== local.length) window.dispatchEvent(new Event(CONTACTS_RESTORED_EVENT))
  }
  restoredFor = id
  await save(id)
}
