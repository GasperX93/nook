import { describe, expect, it } from 'vitest'

import type { NookContact } from '../notify/types'
import { contactsForNodeKey, stripKeyPrefix } from './node-key'

// #122: a rotated Nook identity leaves two contacts sharing one node key.
// The lookup must return the NEWEST first — first-found routed share
// notifications to the stale identity's mailbox, which nobody reads.

const X = 'ab'.repeat(32) // 64-char X coordinate
const Y = 'cd'.repeat(32) // 64-char Y coordinate (uncompressed suffix)

function contact(id: string, beePublicKey: string, addedAt: number): NookContact {
  return { id, nickname: id.slice(0, 6), walletPublicKey: '02' + X, beePublicKey, source: 'identity-feed', addedAt }
}

describe('stripKeyPrefix', () => {
  it('normalizes compressed, uncompressed, prefixless, and 0x forms to the X coordinate', () => {
    expect(stripKeyPrefix('02' + X)).toBe(X)
    expect(stripKeyPrefix('03' + X)).toBe(X)
    expect(stripKeyPrefix('04' + X + Y)).toBe(X)
    expect(stripKeyPrefix(X + Y)).toBe(X)
    expect(stripKeyPrefix('0x02' + X)).toBe(X)
    expect(stripKeyPrefix(('02' + X).toUpperCase())).toBe(X)
  })
})

describe('contactsForNodeKey', () => {
  it('matches across key encodings', () => {
    const c = contact('0xaaa', '04' + X + Y, 1)

    expect(contactsForNodeKey([c], '02' + X)).toEqual([c])
  })

  it('returns the newest contact first on a node-key collision (#122)', () => {
    const stale = contact('0xold', '02' + X, 1000)
    const current = contact('0xnew', '02' + X, 2000)
    const unrelated = contact('0xother', '02' + 'ef'.repeat(32), 3000)

    const matches = contactsForNodeKey([stale, current, unrelated], '02' + X)

    expect(matches.map(c => c.id)).toEqual(['0xnew', '0xold'])
  })

  it('returns empty for an unknown key', () => {
    expect(contactsForNodeKey([contact('0xaaa', '02' + X, 1)], '02' + 'ef'.repeat(32))).toEqual([])
  })
})
