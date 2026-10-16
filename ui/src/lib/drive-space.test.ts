import { describe, expect, it } from 'vitest'

import { driveSpace, fitsInDrive } from './drive-space'

const GB = 1e9

describe('driveSpace', () => {
  it('empty drive: nothing used, everything left', () => {
    const s = driveSpace(2.6 * GB, 0, 0)
    expect(s.usedBytes).toBe(0)
    expect(s.leftBytes).toBe(2.6 * GB)
    expect(s.state).toBe('ok')
  })

  it('uses the recorded file sizes when they are larger than Bee’s figure', () => {
    const s = driveSpace(2.6 * GB, 0.1, 0.5 * GB)
    expect(s.usedBytes).toBe(0.5 * GB)
    expect(s.leftBytes).toBe(2.1 * GB)
  })

  it('uses Bee’s figure when it is larger (uploads Nook has no record of)', () => {
    const s = driveSpace(2.6 * GB, 0.5, 0.2 * GB)
    expect(s.usedBytes).toBe(1.3 * GB)
    expect(s.leftBytes).toBe(1.3 * GB)
  })

  it('almost full from Bee’s figure alone, at 75%', () => {
    expect(driveSpace(2.6 * GB, 0.74, 0).state).toBe('ok')
    expect(driveSpace(2.6 * GB, 0.75, 0).state).toBe('almost-full')
  })

  it('full at 100%: nothing left, whatever the files add up to', () => {
    const s = driveSpace(2.6 * GB, 1, 0.3 * GB)
    expect(s.state).toBe('full')
    expect(s.leftBytes).toBe(0)
    expect(s.usedRatio).toBe(1)
  })

  it('never reports more used than the size', () => {
    const s = driveSpace(110e6, 0.2, 500e6)
    expect(s.usedBytes).toBe(110e6)
    expect(s.leftBytes).toBe(0)
  })
})

describe('fitsInDrive', () => {
  it('fits when the upload is within what is left', () => {
    const s = driveSpace(7.7 * GB, 0, 2 * GB)
    expect(fitsInDrive(s, 5 * GB)).toBe(true)
    expect(fitsInDrive(s, 6 * GB)).toBe(false)
    // 2% of the size stays free for index/manifest chunks.
    expect(fitsInDrive(s, 5.7 * GB - 0.154 * GB + 1)).toBe(false)
  })

  it('never fits on a full drive', () => {
    expect(fitsInDrive(driveSpace(7.7 * GB, 1, 0), 1)).toBe(false)
  })
})
