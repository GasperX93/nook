// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'

import { setActiveIdentity } from './active-identity'
import { appendOutboxMessage, loadThreads, mergeReceived, setMessageStatusByOutboxId } from './messages'
import { enqueueOutboxEntry, loadOutbox, recordOutboxAttempt, removeOutboxEntry, resetOutboxAttempts } from './outbox'

// The outbox contract (#117): the entry is the durable send intent — created
// before any network work, removed only after the network write, surviving
// everything in between (including the app dying).

const ME = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const PEER = '0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB'

function entryFor(id: string, ts = Date.now()) {
  return { id, recipientId: PEER, ts, kind: 'message' as const, body: `msg-${id}` }
}

beforeEach(() => {
  localStorage.clear()
  setActiveIdentity(ME)
})

describe('outbox store', () => {
  it('enqueue → load roundtrip, recipient lowercased, attempts start at 0', () => {
    enqueueOutboxEntry(entryFor('e1'))
    const [e] = loadOutbox()

    expect(e.id).toBe('e1')
    expect(e.recipientId).toBe(PEER.toLowerCase())
    expect(e.attempts).toBe(0)
  })

  it('remove deletes exactly the given entry', () => {
    enqueueOutboxEntry(entryFor('e1'))
    enqueueOutboxEntry(entryFor('e2'))
    removeOutboxEntry('e1')

    expect(loadOutbox().map(e => e.id)).toEqual(['e2'])
  })

  it('recordOutboxAttempt increments and stores the error; missing entry → 0', () => {
    enqueueOutboxEntry(entryFor('e1'))

    expect(recordOutboxAttempt('e1', 'node not ready')).toBe(1)
    expect(recordOutboxAttempt('e1', 'still down')).toBe(2)
    expect(loadOutbox()[0].lastError).toBe('still down')
    expect(recordOutboxAttempt('ghost', 'x')).toBe(0)
  })

  it('resetOutboxAttempts zeroes the counter for tap-to-retry', () => {
    enqueueOutboxEntry(entryFor('e1'))
    recordOutboxAttempt('e1', 'boom')
    const entry = resetOutboxAttempts('e1')

    expect(entry?.attempts).toBe(0)
    expect(entry?.lastError).toBeUndefined()
  })

  it('is namespaced per identity — another wallet sees an empty outbox', () => {
    enqueueOutboxEntry(entryFor('e1'))
    setActiveIdentity('0xcccccccccccccccccccccccccccccccccccccccc')

    expect(loadOutbox()).toEqual([])
  })

  it('corrupt storage loads as empty instead of crashing', () => {
    localStorage.setItem(`nook-outbox-v1:${ME}`, '{not json')

    expect(loadOutbox()).toEqual([])
  })
})

describe('thread bubble status', () => {
  it('appendOutboxMessage creates a sending bubble linked to the entry', () => {
    const entry = enqueueOutboxEntry(entryFor('e1', 1000))

    appendOutboxMessage(loadThreads(), entry)
    const thread = loadThreads()[PEER.toLowerCase()]

    expect(thread).toHaveLength(1)
    expect(thread[0]).toMatchObject({
      direction: 'sent',
      status: 'sending',
      outboxId: 'e1',
      body: 'msg-e1',
      ts: 1000,
    })
  })

  it('setMessageStatusByOutboxId flips exactly the linked bubble', () => {
    appendOutboxMessage(loadThreads(), enqueueOutboxEntry(entryFor('e1')))
    appendOutboxMessage(loadThreads(), enqueueOutboxEntry(entryFor('e2')))

    setMessageStatusByOutboxId(loadThreads(), PEER, 'e1', 'sent')
    const thread = loadThreads()[PEER.toLowerCase()]

    expect(thread.find(m => m.outboxId === 'e1')?.status).toBe('sent')
    expect(thread.find(m => m.outboxId === 'e2')?.status).toBe('sending')
  })

  it('unknown outboxId is a no-op', () => {
    appendOutboxMessage(loadThreads(), enqueueOutboxEntry(entryFor('e1')))
    const before = loadThreads()

    expect(setMessageStatusByOutboxId(before, PEER, 'ghost', 'failed')).toBe(before)
  })

  it('drive-share entries produce drive-share bubbles with card fields', () => {
    const entry = enqueueOutboxEntry({
      ...entryFor('e1'),
      kind: 'drive-share',
      driveShare: { driveShareLink: 'swarm://feed?x', driveName: 'Photos', fileCount: 3 },
    })

    appendOutboxMessage(loadThreads(), entry)
    const [m] = loadThreads()[PEER.toLowerCase()]

    expect(m.kind).toBe('drive-share')
    expect(m.driveName).toBe('Photos')
    expect(m.fileCount).toBe(3)
  })

  it('mergeReceived preserves sending bubbles (inbox refresh must not eat the outbox)', () => {
    appendOutboxMessage(loadThreads(), enqueueOutboxEntry(entryFor('e1')))
    mergeReceived(loadThreads(), PEER, [{ v: 2, ts: 2000, sender: PEER, subject: '', body: 'hi back' } as never])
    const thread = loadThreads()[PEER.toLowerCase()]

    expect(thread.some(m => m.outboxId === 'e1' && m.status === 'sending')).toBe(true)
    expect(thread.some(m => m.direction === 'received' && m.body === 'hi back')).toBe(true)
  })
})
