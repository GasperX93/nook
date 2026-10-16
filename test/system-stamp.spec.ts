jest.mock('env-paths', () =>
  jest.fn().mockImplementation(() => ({
    data: 'test/data/system-stamp-spec',
    config: 'test/data/system-stamp-spec',
    cache: 'test/data/system-stamp-spec',
    log: 'test/data/system-stamp-spec',
    temp: 'test/data/system-stamp-spec',
  })),
)
jest.mock('../src/config', () => ({
  ...jest.requireActual('../src/config'),
  readConfigYaml: () => ({ password: 'pw' }),
}))
jest.mock('../src/notify', () => ({ createNotification: jest.fn() }))
jest.mock('../src/funding-monitor', () => ({ getMode: jest.fn(() => 'light') }))
// The node on 1633 is Nook's own in these tests (the R5-11 spending guard).
jest.mock('../src/foreign-bee', () => ({ isOwnBee: jest.fn(async () => true) }))

import { mkdirSync, rmSync } from 'fs'

import { getAutoExtendSettings, setAutoExtendSetting } from '../src/extend-monitor'
import { getMode } from '../src/funding-monitor'
import { loadNotifications } from '../src/notifications'
import { loadPurchases } from '../src/purchases'
import {
  type BeeFetch,
  reserveJustBoughtAt,
  resetJustBoughtForTests,
  runSystemStampCheck,
  SYSTEM_STAMP_LABEL,
} from '../src/system-stamp'

// #130 contract: buy exactly one labeled system batch, only in light mode with
// a synced chain and sufficient funds; enable auto-renew; record everything.

const DATA = 'test/data/system-stamp-spec'
const BATCH = 'f'.repeat(64)

function cleanUp() {
  rmSync(DATA, { recursive: true, force: true })
  mkdirSync(DATA, { recursive: true })
  ;(getMode as jest.Mock).mockReturnValue('light')
}

function makeBee(overrides: {
  existing?: boolean
  /** Fields of the existing reserve (depth, utilizationRatio, usable, …). */
  reserve?: Record<string, unknown>
  lag?: number
  bzz?: string
  buyStatus?: number
  diluteStatus?: number
}) {
  const buys: { path: string; headers: Record<string, string> }[] = []
  const dilutes: string[] = []
  const fetch: BeeFetch = async (path, init) => {
    if (path.startsWith('/stamps/dilute/') && init?.method === 'PATCH') {
      dilutes.push(path)

      return new Response('{}', { status: overrides.diluteStatus ?? 200 })
    }

    if (path.startsWith('/stamps') && init?.method === 'POST') {
      buys.push({ path, headers: (init.headers ?? {}) as Record<string, string> })

      if (overrides.buyStatus) return new Response('{}', { status: overrides.buyStatus })

      return new Response(JSON.stringify({ batchID: BATCH }), { status: 200 })
    }

    if (path.startsWith('/stamps')) {
      const stamps =
        overrides.existing || overrides.reserve
          ? [{ batchID: BATCH, label: SYSTEM_STAMP_LABEL, usable: true, ...overrides.reserve }]
          : []

      return new Response(JSON.stringify({ stamps }), { status: 200 })
    }

    if (path.startsWith('/chainstate')) {
      return new Response(JSON.stringify({ chainTip: 1000, block: 1000 - (overrides.lag ?? 0), currentPrice: '100' }), {
        status: 200,
      })
    }

    if (path.startsWith('/wallet')) {
      return new Response(JSON.stringify({ bzzBalance: overrides.bzz ?? '99999999999999999' }), { status: 200 })
    }

    return new Response('{}', { status: 404 })
  }

  return { fetch, buys, dilutes }
}

beforeEach(() => {
  cleanUp()
  resetJustBoughtForTests()
})
afterAll(cleanUp)

describe('system stamp (#130)', () => {
  it('buys once with the right shape: label, depth 18, immutable, 1 month of price', async () => {
    const bee = makeBee({})
    const result = await runSystemStampCheck(bee.fetch)

    expect(result).toBe('bought')
    expect(bee.buys).toHaveLength(1)
    // amount per chunk = price 100 × 518400 blocks/mo × 1 month
    expect(bee.buys[0].path).toBe(`/stamps/${100 * 518400}/18?label=${SYSTEM_STAMP_LABEL}`)
    expect(bee.buys[0].headers.immutable).toBe('true')

    // Auto-renew ON by default, matching the purchase duration
    expect(getAutoExtendSettings()[BATCH]).toMatchObject({ enabled: true, months: 1 })

    // Ledger + bell record
    expect(loadPurchases()[0]).toMatchObject({ kind: 'create', batchId: BATCH, label: SYSTEM_STAMP_LABEL })
    expect(loadNotifications()[0].title).toContain('identity & messages')
  })

  it('never buys twice while Bee has not listed the new batch yet (F-6)', async () => {
    const bee = makeBee({})

    expect(await runSystemStampCheck(bee.fetch)).toBe('bought')
    // Bee still lists no system batch a minute later — the purchase must hold.
    expect(await runSystemStampCheck(bee.fetch)).toBe('exists')
    expect(bee.buys).toHaveLength(1)
    expect(reserveJustBoughtAt()).not.toBeNull()
  })

  it('never buys beside an existing system batch', async () => {
    const bee = makeBee({ existing: true })

    expect(await runSystemStampCheck(bee.fetch)).toBe('exists')
    expect(bee.buys).toHaveLength(0)
  })

  it('skips in ultra-light mode without touching Bee', async () => {
    ;(getMode as jest.Mock).mockReturnValue('ultra-light')
    const bee = makeBee({})

    expect(await runSystemStampCheck(bee.fetch)).toBe('skipped')
    expect(bee.buys).toHaveLength(0)
  })

  it('skips while funds are short or the chain lags', async () => {
    const poor = makeBee({ bzz: '1' })

    expect(await runSystemStampCheck(poor.fetch)).toBe('skipped')
    expect(poor.buys).toHaveLength(0)

    const lagging = makeBee({ lag: 500 })

    expect(await runSystemStampCheck(lagging.fetch)).toBe('skipped')
    expect(lagging.buys).toHaveLength(0)
  })

  it('funded-but-short tells the user ONCE how much unlocks identity & messages', async () => {
    const poor = makeBee({ bzz: '1' })

    await runSystemStampCheck(poor.fetch)
    await runSystemStampCheck(poor.fetch)

    const notices = loadNotifications().filter(n => n.type === 'charge-blocked')

    expect(notices).toHaveLength(1)
    expect(notices[0].title).toContain('4 xBZZ')
    expect(notices[0].link).toBe('/account?tab=wallet')

    // Zero balance means "not funded yet" — no nagging before any money exists.
    // (fresh state dir so the once-flag from above doesn't interfere)
    cleanUp()
    const broke = makeBee({ bzz: '0' })

    await runSystemStampCheck(broke.fetch)
    expect(loadNotifications()).toHaveLength(0)
  })

  it('reports a failed buy without recording anything', async () => {
    const bee = makeBee({ buyStatus: 500 })

    expect(await runSystemStampCheck(bee.fetch)).toBe('failed')
    expect(loadPurchases()).toHaveLength(0)
    expect(getAutoExtendSettings()[BATCH]).toBeUndefined()
  })
})

describe('growing the reserve (0.7.2)', () => {
  // price 100: next 1-month extension at depth d = 100 × 518400 × 2^d PLUR —
  // tiny next to the default balance, so "enough funds" unless bzz is set.

  it('grows a reserve bought before 0.7.2 (depth 17) to depth 18', async () => {
    const bee = makeBee({ reserve: { depth: 17, bucketDepth: 16, utilizationRatio: 1 } })

    expect(await runSystemStampCheck(bee.fetch)).toBe('exists')
    expect(bee.dilutes).toEqual([`/stamps/dilute/${BATCH}/18`])
    expect(getAutoExtendSettings()[BATCH]).toMatchObject({ enabled: true, months: 1 })
    expect(loadNotifications()[0].title).toContain('More space')
  })

  it('keeps the user’s choice when auto-extend was turned off', async () => {
    setAutoExtendSetting(BATCH, false, 3)
    const bee = makeBee({ reserve: { depth: 17, bucketDepth: 16, utilizationRatio: 0.5 } })

    await runSystemStampCheck(bee.fetch)
    expect(getAutoExtendSettings()[BATCH]).toMatchObject({ enabled: false, months: 1 })
  })

  it('grows one step once the fullest bucket reaches 75%', async () => {
    const half = makeBee({ reserve: { depth: 18, bucketDepth: 16, utilizationRatio: 0.5 } })

    await runSystemStampCheck(half.fetch)
    expect(half.dilutes).toHaveLength(0)

    const filling = makeBee({ reserve: { depth: 18, bucketDepth: 16, utilizationRatio: 0.75 } })

    await runSystemStampCheck(filling.fetch)
    expect(filling.dilutes).toEqual([`/stamps/dilute/${BATCH}/19`])
  })

  it('reads the fill from utilization on nodes without utilizationRatio', async () => {
    // depth 18 → 4 slots per bucket; 3 used = 75%
    const bee = makeBee({ reserve: { depth: 18, bucketDepth: 16, utilization: 3 } })

    await runSystemStampCheck(bee.fetch)
    expect(bee.dilutes).toEqual([`/stamps/dilute/${BATCH}/19`])
  })

  it('never grows past depth 20', async () => {
    const bee = makeBee({ reserve: { depth: 20, bucketDepth: 16, utilizationRatio: 0.9 } })

    await runSystemStampCheck(bee.fetch)
    expect(bee.dilutes).toHaveLength(0)
  })

  it('without money for the next extension: no grow, one notice per depth while filling', async () => {
    const poor = makeBee({ reserve: { depth: 18, bucketDepth: 16, utilizationRatio: 0.8 }, bzz: '1' })

    await runSystemStampCheck(poor.fetch)
    await runSystemStampCheck(poor.fetch)

    expect(poor.dilutes).toHaveLength(0)
    const notices = loadNotifications().filter(n => n.type === 'charge-blocked')

    expect(notices).toHaveLength(1)
    expect(notices[0].title).toContain('filling up')
  })

  it('an old reserve that is not filling up waits quietly for funds', async () => {
    const poor = makeBee({ reserve: { depth: 17, bucketDepth: 16, utilizationRatio: 0.5 }, bzz: '1' })

    await runSystemStampCheck(poor.fetch)
    expect(poor.dilutes).toHaveLength(0)
    expect(loadNotifications()).toHaveLength(0)
  })

  it('never grows on a lagging chain or an unusable batch', async () => {
    const lagging = makeBee({ reserve: { depth: 17, bucketDepth: 16, utilizationRatio: 1 }, lag: 500 })

    await runSystemStampCheck(lagging.fetch)
    expect(lagging.dilutes).toHaveLength(0)

    const unusable = makeBee({ reserve: { depth: 17, bucketDepth: 16, utilizationRatio: 1, usable: false } })

    await runSystemStampCheck(unusable.fetch)
    expect(unusable.dilutes).toHaveLength(0)
  })

  it('a failed grow changes nothing', async () => {
    const bee = makeBee({ reserve: { depth: 17, bucketDepth: 16, utilizationRatio: 1 }, diluteStatus: 500 })

    await runSystemStampCheck(bee.fetch)
    expect(getAutoExtendSettings()[BATCH]).toBeUndefined()
    expect(loadNotifications()).toHaveLength(0)
  })
})
