import { describe, expect, it } from 'vitest'
import {
  calcStampCost,
  depthToCapacity,
  DURATION_PRESETS,
  plurToBzz,
  SIZE_PRESETS,
  weiToDai,
} from './bee'

// ─── plurToBzz ────────────────────────────────────────────────────────────────

describe('plurToBzz', () => {
  it('returns 0.0000 for zero', () => {
    expect(plurToBzz('0')).toBe('0.0000')
  })

  it('converts exactly 1 BZZ (1e16 PLUR)', () => {
    expect(plurToBzz('10000000000000000')).toBe('1.0000')
  })

  it('converts 0.5 BZZ', () => {
    expect(plurToBzz('5000000000000000')).toBe('0.5000')
  })

  it('converts 1.5 BZZ', () => {
    expect(plurToBzz('15000000000000000')).toBe('1.5000')
  })

  it('pads fractional part with leading zeros', () => {
    // 1 PLUR → whole=0, frac=(1*10000)/1e16 = 0 (truncated) — confirms 4-digit padding
    expect(plurToBzz('10000000000000001')).toBe('1.0000')
  })

  it('converts a large balance', () => {
    // 100 BZZ
    expect(plurToBzz('1000000000000000000')).toBe('100.0000')
  })
})

// ─── weiToDai ─────────────────────────────────────────────────────────────────

describe('weiToDai', () => {
  it('returns 0.0000 for zero', () => {
    expect(weiToDai('0')).toBe('0.0000')
  })

  it('converts exactly 1 xDAI (1e18 wei)', () => {
    expect(weiToDai('1000000000000000000')).toBe('1.0000')
  })

  it('converts 0.5 xDAI', () => {
    expect(weiToDai('500000000000000000')).toBe('0.5000')
  })

  it('converts 1.5 xDAI', () => {
    expect(weiToDai('1500000000000000000')).toBe('1.5000')
  })

  it('converts a large balance', () => {
    // 10 xDAI
    expect(weiToDai('10000000000000000000')).toBe('10.0000')
  })
})

// ─── depthToCapacity ──────────────────────────────────────────────────────────

describe('depthToCapacity', () => {
  it('returns MB for values under 1 GB', () => {
    // depth 17: 2^17 * 4096 = 536 870 912 bytes = 512 MB
    expect(depthToCapacity(17)).toBe('512 MB')
  })

  it('returns MB for depth 16 (256 MB)', () => {
    // depth 16: 2^16 * 4096 = 268 435 456 bytes = 256 MB
    expect(depthToCapacity(16)).toBe('256 MB')
  })

  it('returns GB for depth 19 (2 GB)', () => {
    // depth 19: 2^19 * 4096 = 2 147 483 648 bytes = 2 GB
    expect(depthToCapacity(19)).toBe('2 GB')
  })

  it('returns GB for depth 20 (4 GB)', () => {
    expect(depthToCapacity(20)).toBe('4 GB')
  })

  it('returns GB for depth 22 (16 GB)', () => {
    expect(depthToCapacity(22)).toBe('16 GB')
  })
})

// ─── calcStampCost ────────────────────────────────────────────────────────────

describe('calcStampCost', () => {
  it('returns amount and bzzCost as strings', () => {
    const result = calcStampCost(20, 1, '24000')
    expect(typeof result.amount).toBe('string')
    expect(typeof result.bzzCost).toBe('string')
  })

  it('calculates amount as price × blocks_per_month × months', () => {
    // 518 400 blocks/month (Gnosis ~5s blocks)
    // price=1000, months=1 → 1000 * 518400 = 518 400 000
    const { amount } = calcStampCost(17, 1, '1000')
    expect(amount).toBe('518400000')
  })

  it('scales linearly with months', () => {
    const one = calcStampCost(17, 1, '1000')
    const three = calcStampCost(17, 3, '1000')
    expect(BigInt(three.amount)).toBe(BigInt(one.amount) * 3n)
  })

  it('calculates BZZ cost for a realistic price', () => {
    // depth=20, months=1, price="24000"
    // amount = 24000 * 518400 = 12 441 600 000
    // totalPlur = 12 441 600 000 * 2^20 = 13 045 963 161 600 000
    // bzzCost = 1.3045
    const { amount, bzzCost } = calcStampCost(20, 1, '24000')
    expect(amount).toBe('12441600000')
    expect(bzzCost).toBe('1.3045')
  })

  it('returns zero BZZ cost for price zero', () => {
    const { bzzCost } = calcStampCost(20, 1, '0')
    expect(bzzCost).toBe('0.0000')
  })
})

// ─── SIZE_PRESETS ─────────────────────────────────────────────────────────────

describe('SIZE_PRESETS', () => {
  it('has 4 entries', () => {
    expect(SIZE_PRESETS).toHaveLength(4)
  })

  it('depths are in ascending order', () => {
    const depths = SIZE_PRESETS.map(p => p.depth)
    expect(depths).toEqual([...depths].sort((a, b) => a - b))
  })

  it('every entry has a non-empty label', () => {
    for (const preset of SIZE_PRESETS) {
      expect(preset.label.length).toBeGreaterThan(0)
    }
  })
})

// ─── DURATION_PRESETS ─────────────────────────────────────────────────────────

describe('DURATION_PRESETS', () => {
  it('has 4 entries', () => {
    expect(DURATION_PRESETS).toHaveLength(4)
  })

  it('months are in ascending order', () => {
    const months = DURATION_PRESETS.map(p => p.months)
    expect(months).toEqual([...months].sort((a, b) => a - b))
  })

  it('covers 1 month through 12 months', () => {
    const months = DURATION_PRESETS.map(p => p.months)
    expect(months[0]).toBe(1)
    expect(months[months.length - 1]).toBe(12)
  })
})
