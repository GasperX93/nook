import { describe, expect, it } from 'vitest'

import { extendPlan } from './extend-plan'

const DAY = 86400
const PRICE = '24000'
const base = { batchTTL: 26 * DAY, extendMonths: 0, currentPrice: PRICE }
const blocks = (seconds: number) => BigInt(Math.floor(seconds / 5))

describe('extendPlan', () => {
  it('time only: charged at the drive’s depth', () => {
    const p = extendPlan({ ...base, beeDepth: 19, chainDepth: 19, targetDepth: null, extendMonths: 1 })
    const amount = BigInt(PRICE) * blocks(30 * DAY)

    expect(p.willDilute).toBe(false)
    expect(p.topupAmount).toBe(amount.toString())
    expect(p.totalPlur).toBe(amount << 19n)
  })

  it('bigger size: tops up the halved time, sends 2^delta more per chunk', () => {
    const p = extendPlan({ ...base, beeDepth: 19, chainDepth: 19, targetDepth: 20 })
    const amount = BigInt(PRICE) * blocks(13 * DAY)

    expect(p.willDilute).toBe(true)
    expect(p.topupAmount).toBe((amount << 1n).toString())
    // What the contract takes: topupAmount × 2^19.
    expect(p.totalPlur).toBe(BigInt(p.topupAmount!) << 19n)
  })

  it('Bee behind the chain: no second size change to a size already paid for', () => {
    const p = extendPlan({ ...base, beeDepth: 19, chainDepth: 20, targetDepth: 20 })

    expect(p.beeBehind).toBe(true)
    expect(p.baseDepth).toBe(20)
    expect(p.willDilute).toBe(false)
    expect(p.totalPlur).toBeNull()
  })

  it('Bee behind the chain: time only is charged (and shown) at the chain depth', () => {
    const p = extendPlan({ ...base, beeDepth: 19, chainDepth: 20, targetDepth: null, extendMonths: 1 })

    expect(p.totalPlur).toBe(BigInt(p.topupAmount!) << 20n)
  })

  it('Bee behind the chain: a bigger size goes from the chain depth', () => {
    const p = extendPlan({ ...base, beeDepth: 19, chainDepth: 20, targetDepth: 21 })

    expect(p.willDilute).toBe(true)
    expect(p.totalPlur).toBe(BigInt(p.topupAmount!) << 20n)
    expect(p.totalPlur).toBe((BigInt(PRICE) * blocks(13 * DAY)) << 21n)
  })
})
