// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'

import { setActiveIdentity } from './active-identity'
import { deriveConnectionState, hasInboundSince, markInviteAccepted, recordInviteSent } from './contact-state'
import { addContact, removeContact } from './storage'
import type { NookContact } from './types'

// R3b-3: deleting a contact and adding them back must start over at
// "not connected", so the invite (with its on-chain ping) fires again.

const ME = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const PEER = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'

function contact(addedAt: number): NookContact {
  return { id: PEER, nickname: 'Peer', walletPublicKey: '02', beePublicKey: '03', source: 'share-link', addedAt }
}

beforeEach(() => {
  localStorage.clear()
  setActiveIdentity(ME)
})

describe('hasInboundSince', () => {
  const thread = [
    { direction: 'received' as const, ts: 1_000 },
    { direction: 'sent' as const, ts: 5_000 },
  ]

  it('ignores messages received before the contact was (re-)added', () => {
    expect(hasInboundSince(thread, 2_000)).toBe(false)
  })

  it('counts messages received after the contact was added', () => {
    expect(hasInboundSince([...thread, { direction: 'received', ts: 3_000 }], 2_000)).toBe(true)
  })

  it('counts every received message when addedAt is missing', () => {
    expect(hasInboundSince(thread)).toBe(true)
  })
})

describe('removeContact', () => {
  it('clears invite-sent and accepted markers', () => {
    const contacts = addContact([], contact(1_000))

    recordInviteSent(PEER)
    markInviteAccepted(PEER)
    expect(deriveConnectionState(PEER, false)).toBe('connected')

    removeContact(contacts, PEER)

    expect(deriveConnectionState(PEER, false)).toBe('not-connected')
  })
})
