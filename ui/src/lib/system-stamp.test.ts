import { describe, expect, it } from 'vitest'

import { pickMessagingStamp, SYSTEM_STAMP_LABEL } from './system-stamp'

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

  it('handles empty input', () => {
    expect(pickMessagingStamp(undefined)).toBeNull()
    expect(pickMessagingStamp([])).toBeNull()
  })
})
