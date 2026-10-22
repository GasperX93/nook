// @vitest-environment jsdom
import type { Message as SdkMessage } from '@swarm-notify/sdk'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { type ContactBackup, serverApi } from '../api/server'
import { setActiveIdentity } from './active-identity'
import { CONTACTS_RESTORED_EVENT } from './backup-signal'
import { mergeContacts, restoreContactBackup } from './contact-backup'
import {
  getInviteSentAt,
  getMyDisplayName,
  recordInviteSent,
  setMyDisplayName,
  wasInviteAccepted,
} from './contact-state'
import { showOtherBrowserNotice } from './other-browser'
import {
  advanceSendCursor,
  appendReceived,
  appendSent,
  conversationLoading,
  conversationPending,
  LOADING_CAP_MS,
  getSendCursor,
  loadReadCursors,
  loadThreads,
  markSentLoaded,
  needsSentLoad,
  mergeSentFromFeed,
  sentReadComplete,
  setMessageStatusByOutboxId,
  appendOutboxMessage,
  theirSidePending,
} from './messages'
import { getReadCursor, MAX_HOLE_TRIES, positionsToKeep, raiseExpected, recordRead } from './receive-cursor'
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

  it('how far their feeds were read comes back and is saved again, the higher one wins', async () => {
    recordRead(ANA, { nextIndex: 9, holes: [] })
    saved = { contacts: [], sendCursors: {}, theirNext: { [MARTIN]: 40, [ANA]: 5 }, myName: '' }

    await restoreContactBackup(ME)

    expect(writes[writes.length - 1].theirNext).toEqual({ [MARTIN]: 40, [ANA]: 9 })
  })

  it('a browser that has read a conversation itself never waits for the position another browser reached', async () => {
    recordRead(MARTIN, { nextIndex: 24, holes: [] })
    saved = { contacts: [], sendCursors: {}, theirNext: { [MARTIN]: 25 }, myName: '' }

    await restoreContactBackup(ME)

    expect(conversationPending(MARTIN)).toBe(false)
  })

  it('a position another browser reached, stored earlier, is forgotten once this browser reads itself', async () => {
    raiseExpected({ [MARTIN]: 25 })
    recordRead(MARTIN, { nextIndex: 24, holes: [] })
    saved = { contacts: [], sendCursors: {}, theirNext: { [MARTIN]: 25 }, myName: '' }

    await restoreContactBackup(ME)

    expect(conversationPending(MARTIN)).toBe(false)
  })

  it('a file from before read positions were kept still restores', async () => {
    saved = { contacts: [contact(MARTIN, 'Martin')], sendCursors: {}, myName: '' }

    await restoreContactBackup(ME)

    expect(loadContacts().map(c => c.id)).toEqual([MARTIN])
    expect(conversationPending(MARTIN)).toBe(false)
  })

  it('invites sent and accepted come back and are saved again, the later one wins', async () => {
    recordInviteSent(ANA, 900)
    saved = {
      contacts: [],
      sendCursors: {},
      invitesSent: { [MARTIN]: 500, [ANA]: 100 },
      invitesAccepted: { [MARTIN]: 600 },
      myName: '',
    }

    await restoreContactBackup(ME)

    expect(getInviteSentAt(MARTIN)).toBe(500)
    expect(getInviteSentAt(ANA)).toBe(900)
    expect(wasInviteAccepted(MARTIN)).toBe(true)
    expect(writes[writes.length - 1].invitesSent).toEqual({ [MARTIN]: 500, [ANA]: 900 })
  })

  it('contacts restored into a browser without drive data: the drive notice shows', async () => {
    saved = { contacts: [contact(MARTIN, 'Martin')], sendCursors: {}, myName: '' }

    await restoreContactBackup(ME)

    expect(showOtherBrowserNotice()).toBe(true)
  })

  it('no drive notice in a browser that has its own drive data', async () => {
    localStorage.setItem('swarm-drive', '[]')
    saved = { contacts: [contact(MARTIN, 'Martin')], sendCursors: {}, myName: '' }

    await restoreContactBackup(ME)

    expect(showOtherBrowserNotice()).toBe(false)
  })

  it('no drive notice when nothing was restored (the usual browser)', async () => {
    saveContacts([contact(MARTIN, 'Martin')])
    saved = { contacts: [contact(MARTIN, 'Martin')], sendCursors: {}, myName: '' }

    await restoreContactBackup(ME)

    expect(showOtherBrowserNotice()).toBe(false)
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

describe('conversation loading (#191)', () => {
  it('a new browser waits until it has read their feed as far as one of mine had', () => {
    raiseExpected({ [MARTIN]: 40 })
    expect(conversationPending(MARTIN)).toBe(true)

    recordRead(MARTIN, { nextIndex: 20, holes: [] })
    expect(conversationPending(MARTIN)).toBe(true)

    recordRead(MARTIN, { nextIndex: 40, holes: [] })
    expect(conversationPending(MARTIN)).toBe(false)
  })

  it('an empty read proves nothing: still waiting while the position is short', () => {
    raiseExpected({ [MARTIN]: 40 })
    recordRead(MARTIN, { nextIndex: 0, holes: [] })
    recordRead(MARTIN, { nextIndex: 0, holes: [] })
    recordRead(MARTIN, { nextIndex: 0, holes: [] })

    expect(conversationPending(MARTIN)).toBe(true)
  })

  it('nothing known about a contact (new, or never wrote) means nothing to wait for', () => {
    expect(conversationPending(ANA)).toBe(false)
    recordRead(ANA, { nextIndex: 0, holes: [] })
    expect(conversationPending(ANA)).toBe(false)
  })

  it('their slots that exist but could not be read yet keep it loading until one of theirs is here', () => {
    recordRead(MARTIN, { nextIndex: 3, holes: [0, 1, 2] })
    expect(conversationPending(MARTIN)).toBe(true)

    appendReceived(loadThreads(), MARTIN, [message('hey', 5)])
    expect(conversationPending(MARTIN)).toBe(false)
  })

  it('my side waits for my sent messages only where I sent some', () => {
    recordRead(MARTIN, { nextIndex: 0, holes: [] })
    expect(conversationPending(MARTIN)).toBe(false)

    advanceSendCursor(MARTIN, 46)
    expect(conversationPending(MARTIN)).toBe(true)

    markSentLoaded(MARTIN)
    expect(conversationPending(MARTIN)).toBe(false)
  })

  it('two browsers: positions only ever go up, and the higher one is kept', () => {
    raiseExpected({ [MARTIN]: 40 })
    raiseExpected({ [MARTIN]: 10 })
    recordRead(ANA, { nextIndex: 7, holes: [] })

    expect(positionsToKeep()).toEqual({ [MARTIN]: 40, [ANA]: 7 })
  })

  it('the screen shows loading at most LOADING_CAP_MS from when the conversation was first shown', () => {
    raiseExpected({ [ANA]: 3 })

    expect(conversationLoading(ANA, 1_000)).toBe(true)
    expect(conversationLoading(ANA, 1_000 + LOADING_CAP_MS - 1)).toBe(true)
    expect(conversationLoading(ANA, 1_000 + LOADING_CAP_MS)).toBe(false)
  })

  it('hopped gaps are retried; one delivered later goes, the other stays on the list', () => {
    recordRead(MARTIN, { nextIndex: 4, holes: [], gaps: [0, 1], indexes: [3] }, [])
    expect(getReadCursor(MARTIN).retryIndices).toEqual([0, 1])

    recordRead(MARTIN, { nextIndex: 4, holes: [], gaps: [], indexes: [0] }, [0, 1])
    expect(getReadCursor(MARTIN).retryIndices).toEqual([1])
  })

  it('a try counts only for slots actually retried in that read', () => {
    recordRead(MARTIN, { nextIndex: 5, holes: [2] }, [])
    recordRead(MARTIN, { nextIndex: 5, holes: [], indexes: [] }, [])
    for (let i = 1; i < MAX_HOLE_TRIES - 1; i++) recordRead(MARTIN, { nextIndex: 5, holes: [2] }, [2])

    expect(getReadCursor(MARTIN).retryIndices).toEqual([2])
  })

  it('their side still to load means they wrote to me; mine alone does not', () => {
    advanceSendCursor(ANA, 3)
    expect(theirSidePending(ANA)).toBe(false)

    raiseExpected({ [ANA]: 2 })
    expect(theirSidePending(ANA)).toBe(true)
  })

  it('a hopped gap and a retried slot not yet delivered are tried again', () => {
    recordRead(MARTIN, { nextIndex: 5, holes: [], gaps: [2] })
    expect(getReadCursor(MARTIN).retryIndices).toEqual([2])

    // Retried, read as missing again (the SDK reports nothing for it): kept.
    recordRead(MARTIN, { nextIndex: 5, holes: [], indexes: [] })
    expect(getReadCursor(MARTIN).retryIndices).toEqual([2])

    // Delivered this time: done.
    recordRead(MARTIN, { nextIndex: 5, holes: [], indexes: [2] })
    expect(getReadCursor(MARTIN).retryIndices).toEqual([])
  })
})

describe('sent messages from my feed', () => {
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

  it('fills an empty thread with what I sent, in time order', () => {
    mergeSentFromFeed(loadThreads(), MARTIN, [message('hi', 10), message('again', 30)], [0, 1])

    expect(loadThreads()[MARTIN].map(m => [m.body, m.feedIndex])).toEqual([
      ['hi', 0],
      ['again', 1],
    ])
  })

  it('a message read twice from the feed shows once', () => {
    mergeSentFromFeed(loadThreads(), MARTIN, [message('hi', 10)], [0])
    mergeSentFromFeed(loadThreads(), MARTIN, [message('hi', 10)], [0])

    expect(loadThreads()[MARTIN]).toHaveLength(1)
  })

  it('recognises a message sent from this browser by its feed index, however late it went out', () => {
    appendOutboxMessage(loadThreads(), { id: 'o1', recipientId: MARTIN, ts: 1_000, kind: 'message', body: 'later' })
    setMessageStatusByOutboxId(loadThreads(), MARTIN, 'o1', 'sent', 4)
    mergeSentFromFeed(loadThreads(), MARTIN, [message('later', 1_000 + 60 * 60_000)], [4])

    expect(loadThreads()[MARTIN].map(m => m.body)).toEqual(['later'])
  })

  it('an older local message without an index is matched by text and time, and takes the index', () => {
    appendSent(loadThreads(), MARTIN, 'hi', 11)
    mergeSentFromFeed(loadThreads(), MARTIN, [message('hi', 10)], [0])

    expect(loadThreads()[MARTIN].map(m => [m.ts, m.feedIndex])).toEqual([[11, 0]])
  })

  it('a message that waited long in the outbox is still recognised, by the closest time', () => {
    appendSent(loadThreads(), MARTIN, 'hi', 1_000)
    appendSent(loadThreads(), MARTIN, 'hi', 50_000_000)
    mergeSentFromFeed(loadThreads(), MARTIN, [message('hi', 1_000 + 3 * 60 * 60_000)], [0])

    expect(loadThreads()[MARTIN].map(m => [m.ts, m.feedIndex])).toEqual([
      [1_000, 0],
      [50_000_000, undefined],
    ])
  })

  it('a failed message never went out, so it never takes a feed message', () => {
    appendOutboxMessage(loadThreads(), { id: 'o1', recipientId: MARTIN, ts: 10, kind: 'message', body: 'hi' })
    setMessageStatusByOutboxId(loadThreads(), MARTIN, 'o1', 'failed')
    mergeSentFromFeed(loadThreads(), MARTIN, [message('hi', 20)], [0])

    expect(loadThreads()[MARTIN]).toHaveLength(2)
  })

  it('a message still going out never takes an older one from the feed', () => {
    appendOutboxMessage(loadThreads(), { id: 'o1', recipientId: MARTIN, ts: 100, kind: 'message', body: 'hi' })
    mergeSentFromFeed(loadThreads(), MARTIN, [message('hi', 10)], [0])

    expect(loadThreads()[MARTIN]).toHaveLength(2)
  })

  it('when it goes out, a copy of the same slot added from the feed in the meantime is dropped', () => {
    appendOutboxMessage(loadThreads(), { id: 'o1', recipientId: MARTIN, ts: 100, kind: 'message', body: 'hi' })
    mergeSentFromFeed(loadThreads(), MARTIN, [message('hi', 105)], [3])
    setMessageStatusByOutboxId(loadThreads(), MARTIN, 'o1', 'sent', 3)

    expect(loadThreads()[MARTIN].map(m => [m.outboxId, m.feedIndex])).toEqual([['o1', 3]])
  })

  it('an invite already shown from the feed is not added again', () => {
    mergeSentFromFeed(loadThreads(), MARTIN, [message('hi', 105)], [0])
    appendSent(loadThreads(), MARTIN, 'hi', 110, 0)

    expect(loadThreads()[MARTIN]).toHaveLength(1)
  })

  it('adds what I sent from another browser', () => {
    appendSent(loadThreads(), MARTIN, 'hi', 11, 0)
    mergeSentFromFeed(loadThreads(), MARTIN, [message('hi', 10), message('from incognito', 50)], [0, 1])

    expect(loadThreads()[MARTIN].map(m => m.body)).toEqual(['hi', 'from incognito'])
  })

  it('the same text sent twice shows twice', () => {
    appendSent(loadThreads(), MARTIN, 'ok', 11)
    mergeSentFromFeed(loadThreads(), MARTIN, [message('ok', 10), message('ok', 20)], [0, 1])

    expect(loadThreads()[MARTIN].map(m => m.body)).toEqual(['ok', 'ok'])
  })
})
