// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'

import { setActiveIdentity } from './active-identity'
import { appendReceived, appendSent, loadThreads } from './messages'
import { getReadCursor, MAX_HOLE_TRIES, recordRead } from './receive-cursor'

// R3b-2: the poller resumes from a cursor and appends — it must never lose
// earlier received messages or retry a permanent hole forever.

const ME = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const PEER = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'

const msg = (ts: number, body: string) => ({ v: 2, ts, sender: PEER, subject: '', body }) as never

beforeEach(() => {
  localStorage.clear()
  setActiveIdentity(ME)
})

describe('read cursor', () => {
  it('starts a new contact at 0 with nothing to retry', () => {
    expect(getReadCursor(PEER)).toEqual({ fromIndex: 0, retryIndices: [] })
  })

  it('resumes from the recorded cursor and never moves backwards', () => {
    recordRead(PEER, { nextIndex: 5, holes: [] })
    recordRead(PEER, { nextIndex: 3, holes: [] })
    expect(getReadCursor(PEER).fromIndex).toBe(5)
  })

  it('retries a hole until it recovers or runs out of tries', () => {
    recordRead(PEER, { nextIndex: 4, holes: [2] })
    expect(getReadCursor(PEER).retryIndices).toEqual([2])

    for (let i = 1; i < MAX_HOLE_TRIES; i++) recordRead(PEER, { nextIndex: 4, holes: [2] })
    expect(getReadCursor(PEER).retryIndices).toEqual([])
  })
})

describe('appendReceived', () => {
  it('keeps earlier received and sent messages and drops duplicates', () => {
    appendReceived(loadThreads(), PEER, [msg(1000, 'first')])
    appendSent(loadThreads(), PEER, 'mine', 1500)
    appendReceived(loadThreads(), PEER, [msg(1000, 'first'), msg(2000, 'second')])

    expect(loadThreads()[PEER].map(m => m.body)).toEqual(['first', 'mine', 'second'])
  })
})
