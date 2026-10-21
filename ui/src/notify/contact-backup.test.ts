// @vitest-environment jsdom
import type { Message as SdkMessage } from '@swarm-notify/sdk'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { type ContactBackup, serverApi } from '../api/server'
import { setActiveIdentity } from './active-identity'
import { CONTACTS_RESTORED_EVENT } from './backup-signal'
import { mergeContacts, restoreContactBackup } from './contact-backup'
import { getMyDisplayName, setMyDisplayName } from './contact-state'
import {
  advanceSendCursor,
  appendReceived,
  appendSent,
  awaitingFirstRead,
  FIRST_READ_WAIT_MS,
  getSendCursor,
  loadReadCursors,
  loadThreads,
  markSentLoaded,
  needsSentLoad,
  restoreSent,
  sentReadComplete,
} from './messages'
import { loadContacts, saveContacts } from './storage'
import type { NookContact } from './types'

// Contacts in the app folder (#192) and sent messages from my own feed (#191):
// another browser or cleared site data must not lose contacts, and an empty
// browser must never overwrite the saved copy.

const ME = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const MARTIN = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
const ANA = '0xcccccccccccccccccccccccccccccccccccccccc'

function contact(id: string, nickname: string): NookContact {
  return { id, nickname, walletPublicKey: '02' + '11'.repeat(32), beePublicKey: '', source: 'share-link', addedAt: 1 }
}

function message(body: string, ts: number): SdkMessage {
  return { v: 1, subject: '', body, ts, sender: ME } as SdkMessage
}

let saved: ContactBackup | null
let writes: ContactBackup[]

beforeEach(() => {
  localStorage.clear()
  setActiveIdentity(ME)
  saved = null
  writes = []
  vi.restoreAllMocks()
  vi.spyOn(serverApi, 'readContactBackup').mockImplementation(async () => ({ backup: saved }))
  vi.spyOn(serverApi, 'writeContactBackup').mockImplementation(async (_address, backup) => {
    writes.push(JSON.parse(JSON.stringify(backup)))

    return { stored: true }
  })
})

describe('mergeContacts', () => {
  it('adds saved contacts this browser lacks, keeps the local ones as they are', () => {
    const merged = mergeContacts(
      [contact(MARTIN, 'Martin (local name)')],
      [contact(MARTIN, 'Martin'), contact(ANA, 'Ana')],
    )

    expect(merged.map(c => [c.id, c.nickname])).toEqual([
      [MARTIN, 'Martin (local name)'],
      [ANA, 'Ana'],
    ])
  })
})

describe('restoreContactBackup', () => {
  it('another browser: contacts, send cursors and name come back', async () => {
    saved = { contacts: [contact(MARTIN, 'Martin')], sendCursors: { [MARTIN]: 7 }, myName: 'Gasper' }

    await restoreContactBackup(ME)

    expect(loadContacts().map(c => c.nickname)).toEqual(['Martin'])
    expect(getSendCursor(MARTIN)).toBe(7)
    expect(getMyDisplayName()).toBe('Gasper')
  })

  it('tells the inbox poller to read restored contacts right away', async () => {
    const heard = vi.fn()

    window.addEventListener(CONTACTS_RESTORED_EVENT, heard)
    saved = { contacts: [contact(MARTIN, 'Martin')], sendCursors: {}, myName: '' }
    await restoreContactBackup(ME)
    window.removeEventListener(CONTACTS_RESTORED_EVENT, heard)

    expect(heard).toHaveBeenCalledTimes(1)
  })

  it('read marks come back, the later one wins — read messages stay read', async () => {
    localStorage.setItem(`nook-messages-read-v1:${ME}`, JSON.stringify({ [ANA]: 500 }))
    saved = { contacts: [], sendCursors: {}, readMarks: { [MARTIN]: 1000, [ANA]: 200 }, myName: '' }

    await restoreContactBackup(ME)

    expect(loadReadCursors()).toEqual({ [MARTIN]: 1000, [ANA]: 500 })
  })

  it('never lowers a send cursor or replaces a name this browser has', async () => {
    setMyDisplayName('Local name')
    localStorage.setItem(`nook-messages-send-v1:${ME}`, JSON.stringify({ [MARTIN]: 9 }))
    saved = { contacts: [], sendCursors: { [MARTIN]: 3 }, myName: 'Saved name' }

    await restoreContactBackup(ME)

    expect(getSendCursor(MARTIN)).toBe(9)
    expect(getMyDisplayName()).toBe('Local name')
  })

  it('saves the merged result, including contacts only this browser had', async () => {
    saveContacts([contact(ANA, 'Ana')])
    saved = { contacts: [contact(MARTIN, 'Martin')], sendCursors: {}, myName: '' }

    await restoreContactBackup(ME)

    expect(writes[writes.length - 1].contacts.map(c => c.id).sort()).toEqual([MARTIN, ANA].sort())
  })

  it('an unreadable saved copy is never overwritten', async () => {
    vi.mocked(serverApi.readContactBackup).mockRejectedValue(new Error('down'))

    await restoreContactBackup(ME)
    saveContacts([])
    await new Promise(resolve => setTimeout(resolve, 600))

    expect(writes).toEqual([])
  })

  it('after the restore, a change is saved', async () => {
    await restoreContactBackup(ME)
    writes = []
    saveContacts([contact(ANA, 'Ana')])
    await new Promise(resolve => setTimeout(resolve, 600))

    expect(writes[writes.length - 1].contacts.map(c => c.id)).toEqual([ANA])
  })
})

describe('restoreSent', () => {
  it('sent messages are loaded once, only where this browser shows none', () => {
    expect(needsSentLoad(MARTIN)).toBe(true)
    markSentLoaded(MARTIN)
    expect(needsSentLoad(MARTIN)).toBe(false)

    appendSent(loadThreads(), ANA, 'hi', 11)
    expect(needsSentLoad(ANA)).toBe(false)
  })

  it('a read of my feed counts only once it reaches my send cursor', () => {
    expect(sentReadComplete(MARTIN, 0)).toBe(true)
    advanceSendCursor(MARTIN, 46)
    expect(sentReadComplete(MARTIN, 0)).toBe(false)
    expect(sentReadComplete(MARTIN, 47)).toBe(true)
  })

  it('waits for their messages after mine were loaded, but not past the cap', () => {
    expect(awaitingFirstRead(MARTIN, 1_000)).toBe(false)
    markSentLoaded(MARTIN, 1_000)
    expect(awaitingFirstRead(MARTIN, 2_000)).toBe(true)
    expect(awaitingFirstRead(MARTIN, 1_000 + FIRST_READ_WAIT_MS)).toBe(false)

    appendReceived(loadThreads(), MARTIN, [message('hey', 5)])
    expect(awaitingFirstRead(MARTIN, 2_000)).toBe(false)
  })

  it('fills an empty thread with what I sent, in time order with the received ones', () => {
    restoreSent(loadThreads(), MARTIN, [message('hi', 10), message('again', 30)])

    expect(loadThreads()[MARTIN].map(m => [m.body, m.direction])).toEqual([
      ['hi', 'sent'],
      ['again', 'sent'],
    ])
  })

  it('leaves a thread that already has sent messages alone (no duplicates)', () => {
    appendSent(loadThreads(), MARTIN, 'hi', 11)
    restoreSent(loadThreads(), MARTIN, [message('hi', 10)])

    expect(loadThreads()[MARTIN].map(m => m.ts)).toEqual([11])
  })
})
