import { describe, expect, it } from 'vitest'

import { normalizeNookAddress } from './nook-address'

const ADDR = '0x0a4dd66d88e5fab39b6915b66081ad64813994b1'

describe('normalizeNookAddress', () => {
  it('keeps a full address', () => {
    expect(normalizeNookAddress(ADDR)).toBe(ADDR)
  })

  it('accepts an address pasted without 0x', () => {
    expect(normalizeNookAddress(ADDR.slice(2))).toBe(ADDR)
  })

  it('ignores case and surrounding spaces', () => {
    expect(normalizeNookAddress(`  0X${ADDR.slice(2).toUpperCase()} \n`)).toBe(ADDR)
  })

  it('rejects anything that is not 40 hex characters', () => {
    for (const s of [
      '',
      '0x',
      ADDR.slice(0, -1),
      `${ADDR}0`,
      `0x${'g'.repeat(40)}`,
      'mina.eth',
      `0x0x${ADDR.slice(2)}`,
    ]) {
      expect(normalizeNookAddress(s)).toBeNull()
    }
  })

  it('does not mistake a public key for an address', () => {
    expect(normalizeNookAddress(`02${'ab'.repeat(32)}`)).toBeNull()
  })
})
