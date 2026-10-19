import { describe, expect, it } from 'vitest'

import { isReserveBatch, pickMessagingStamp, RETIRED_SYSTEM_STAMP_LABEL, SYSTEM_STAMP_LABEL } from './system-stamp'

// #130: identity/messaging prefer the reserved system batch; drive batches
// are the graceful fallback (degraded), reclaimable batches never qualify.

const system = { batchID: 'aa'.repeat(32), usable: true, label: SYSTEM_STAMP_LABEL }
const drive = { batchID: 'bb'.repeat(32), usable: true, label: 'Photos' }
const reclaimable = { batchID: 'cc'.repeat(32), usable: true, label: 'Deletable' }

describe('pickMessagingStamp', () => {
  it('prefers the system batch and reports non-degraded', () => {
    expect(pickMessagingStamp([drive, system])).toEqual({ batchID: system.batchID, degraded: false })
  })

  it('falls back to a drive batch as degraded', () => {
    expect(pickMessagingStamp([drive])).toEqual({ batchID: drive.batchID, degraded: true })
  })

  it('never picks reclaimable or unusable batches', () => {
    const ids = new Set([reclaimable.batchID])

    expect(pickMessagingStamp([reclaimable], ids)).toBeNull()
    expect(pickMessagingStamp([{ ...system, usable: false }])).toBeNull()
    expect(pickMessagingStamp([reclaimable, drive], ids)).toEqual({ batchID: drive.batchID, degraded: true })
  })

  it('skips a full reserve (writes into it would fail) until it is replaced', () => {
    const full = { ...system, depth: 17, bucketDepth: 16, utilizationRatio: 1 }

    expect(pickMessagingStamp([full, drive])).toEqual({ batchID: drive.batchID, degraded: true })
    expect(pickMessagingStamp([{ ...full, utilizationRatio: 0.5 }, drive])).toEqual({
      batchID: system.batchID,
      degraded: false,
    })
    // Older nodes without utilizationRatio: depth 17 holds 2 per bucket.
    expect(pickMessagingStamp([{ ...system, depth: 17, bucketDepth: 16, utilization: 2 }, drive])).toEqual({
      batchID: drive.batchID,
      degraded: true,
    })
  })

  it('never uses a retired reserve, not even as the fallback', () => {
    const retired = { ...system, batchID: 'dd'.repeat(32), label: RETIRED_SYSTEM_STAMP_LABEL }

    expect(pickMessagingStamp([retired])).toBeNull()
    expect(pickMessagingStamp([retired, drive])).toEqual({ batchID: drive.batchID, degraded: true })
    expect(pickMessagingStamp([retired, system])).toEqual({ batchID: system.batchID, degraded: false })
    expect(isReserveBatch(retired)).toBe(true)
    expect(isReserveBatch(drive)).toBe(false)
  })

  it('handles empty input', () => {
    expect(pickMessagingStamp(undefined)).toBeNull()
    expect(pickMessagingStamp([])).toBeNull()
  })
})
