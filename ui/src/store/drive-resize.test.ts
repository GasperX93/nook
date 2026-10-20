import { describe, expect, it } from 'vitest'

import { growingTo } from './drive-resize'

describe('growingTo', () => {
  const entry = { depth: 20, at: 1_000_000 }

  it('nothing pending: no note', () => {
    expect(growingTo(undefined, 19, entry.at)).toBeNull()
  })

  it('Bee still shows the old size: growing', () => {
    expect(growingTo(entry, 19, entry.at + 60_000)).toBe(20)
  })

  it('Bee shows the new size: done', () => {
    expect(growingTo(entry, 20, entry.at + 60_000)).toBeNull()
  })

  it('gives up after 15 minutes', () => {
    expect(growingTo(entry, 19, entry.at + 15 * 60_000 + 1)).toBeNull()
  })
})
