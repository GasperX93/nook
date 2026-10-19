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

import { mkdirSync, rmSync, writeFileSync } from 'fs'

import { getAutoExtendSettings, setAutoExtendSetting } from '../src/extend-monitor'
import { getMode } from '../src/funding-monitor'
import { loadNotifications } from '../src/notifications'
import { loadPurchases } from '../src/purchases'
import {
  type BeeFetch,
  RETIRED_SYSTEM_STAMP_LABEL,
  reserveJustBoughtAt,
  runSystemStampCheck,
  startSystemStampMonitor,
  SYSTEM_STAMP_LABEL,
} from '../src/system-stamp'

// #130 contract: buy exactly one labeled system batch, only in light mode with
// a synced chain and sufficient funds; enable auto-renew; record everything.

const DATA = 'test/data/system-stamp-spec'
const BATCH = 'f'.repeat(64)
const OLD = 'e'.repeat(64)

function cleanUp() {
  rmSync(DATA, { recursive: true, force: true })
  mkdirSync(DATA, { recursive: true })
  ;(getMode as jest.Mock).mockReturnValue('light')
}

function makeBee(overrides: {
  existing?: boolean
  /** Fields of the existing reserve (depth, utilizationRatio, usable, …). */
  reserve?: Record<string, unknown>
  /** More batches Bee lists (each needs batchID + label). */
  extra?: Record<string, unknown>[]
  lag?: number
  bzz?: string
  buyStatus?: number
  labelStatus?: number
}) {
  const buys: { path: string; headers: Record<string, string> }[] = []
  const labels: { path: string; label: string }[] = []
  const dilutes: string[] = []
  let stamps: Record<string, unknown>[] = [
    ...(overrides.existing || overrides.reserve
      ? [{ batchID: OLD, label: SYSTEM_STAMP_LABEL, usable: true, ...overrides.reserve }]
      : []),
    ...(overrides.extra ?? []),
  ]
  const fetch: BeeFetch = async (path, init) => {
    if (path.startsWith('/stamps/dilute/')) {
      dilutes.push(path)

      return new Response('{}', { status: 200 })
    }

    if (/^\/stamps\/[0-9a-f]{64}$/.test(path) && init?.method === 'PATCH') {
      const { label } = JSON.parse(String(init.body)) as { label: string }

      labels.push({ path, label })

      if (overrides.labelStatus) return new Response('{}', { status: overrides.labelStatus })
      const id = path.slice('/stamps/'.length)

      stamps = stamps.map(st => (st.batchID === id ? { ...st, label } : st))

      return new Response('{}', { status: 200 })
    }

    if (path.startsWith('/stamps') && init?.method === 'POST') {
      buys.push({ path, headers: (init.headers ?? {}) as Record<string, string> })

      if (overrides.buyStatus) return new Response('{}', { status: overrides.buyStatus })

      return new Response(JSON.stringify({ batchID: BATCH }), { status: 200 })
    }

    if (path.startsWith('/stamps')) {
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

  /** Bee lists the batch just bought (as it does a few blocks later). */
  function listBought(fields: Record<string, unknown> = {}) {
    stamps = [
      ...stamps,
      { batchID: BATCH, label: SYSTEM_STAMP_LABEL, usable: true, depth: 18, bucketDepth: 16, ...fields },
    ]
  }

  return { fetch, buys, labels, dilutes, listBought, stamps: () => stamps }
}

beforeEach(cleanUp)
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

describe('replacing the reserve (0.7.2)', () => {
  // A reserve is never grown in place: Bee 2.8.3 forgets a depth increase on
  // restart unless the batch was written to in between (seen live 2026-10-17).

  it('replaces a reserve bought before 0.7.2 (depth 17): buys one at 18, retires the old', async () => {
    const bee = makeBee({ reserve: { depth: 17, bucketDepth: 16, utilizationRatio: 0.5 } })

    expect(await runSystemStampCheck(bee.fetch)).toBe('bought')
    expect(bee.buys).toHaveLength(1)
    expect(bee.buys[0].path).toContain('/18?label=')
    expect(bee.labels).toEqual([{ path: `/stamps/${OLD}`, label: RETIRED_SYSTEM_STAMP_LABEL }])
    expect(getAutoExtendSettings()[OLD]).toMatchObject({ enabled: false })
    expect(getAutoExtendSettings()[BATCH]).toMatchObject({ enabled: true, months: 1 })
    expect(loadNotifications()[0].title).toBe('New space for your identity & messages')
    expect(bee.dilutes).toHaveLength(0)
  })

  it('replaces a full reserve (Bee’s view: depth 17 although the chain says 18)', async () => {
    const bee = makeBee({ reserve: { depth: 17, bucketDepth: 16, utilizationRatio: 1 } })

    expect(await runSystemStampCheck(bee.fetch)).toBe('bought')
    expect(bee.dilutes).toHaveLength(0)
  })

  it('replaces a full depth-18 reserve, and reads the fill from utilization on older nodes', async () => {
    const full = makeBee({ reserve: { depth: 18, bucketDepth: 16, utilization: 4 } })

    expect(await runSystemStampCheck(full.fetch)).toBe('bought')
  })

  it('leaves a working reserve alone, however full', async () => {
    const bee = makeBee({ reserve: { depth: 18, bucketDepth: 16, utilizationRatio: 0.75 } })

    expect(await runSystemStampCheck(bee.fetch)).toBe('exists')
    expect(bee.buys).toHaveLength(0)
    expect(bee.labels).toHaveLength(0)
    expect(bee.dilutes).toHaveLength(0)
  })

  it('buys once: the old one is retired, the new one not listed yet — no second buy', async () => {
    const bee = makeBee({ reserve: { depth: 17, bucketDepth: 16, utilizationRatio: 1 } })

    await runSystemStampCheck(bee.fetch)
    await runSystemStampCheck(bee.fetch)
    await runSystemStampCheck(bee.fetch)
    expect(bee.buys).toHaveLength(1)

    bee.listBought()
    expect(await runSystemStampCheck(bee.fetch)).toBe('exists')
    expect(bee.buys).toHaveLength(1)
  })

  it('retires the old one later when renaming it failed the first time', async () => {
    const bee = makeBee({ reserve: { depth: 17, bucketDepth: 16, utilizationRatio: 1 }, labelStatus: 500 })

    await runSystemStampCheck(bee.fetch)
    bee.listBought()
    await runSystemStampCheck(bee.fetch)

    // Two labelled batches, one working: keep the new one, retry the rename.
    expect(bee.buys).toHaveLength(1)
    expect(bee.labels.filter(l => l.path === `/stamps/${OLD}`).length).toBeGreaterThanOrEqual(2)
    expect(bee.labels.some(l => l.path === `/stamps/${BATCH}`)).toBe(false)
  })

  it('keeps the user’s auto-extend choice on the new reserve', async () => {
    setAutoExtendSetting(OLD, false, 1)
    const bee = makeBee({ reserve: { depth: 17, bucketDepth: 16, utilizationRatio: 1 } })

    await runSystemStampCheck(bee.fetch)
    expect(getAutoExtendSettings()[BATCH]).toMatchObject({ enabled: false, months: 1 })
  })

  it('without money for a replacement: no buy, one notice, messages fall back', async () => {
    const poor = makeBee({ reserve: { depth: 17, bucketDepth: 16, utilizationRatio: 1 }, bzz: '1' })

    await runSystemStampCheck(poor.fetch)
    await runSystemStampCheck(poor.fetch)

    expect(poor.buys).toHaveLength(0)
    expect(poor.labels).toHaveLength(0)
    const notices = loadNotifications().filter(n => n.type === 'charge-blocked')

    expect(notices).toHaveLength(1)
    expect(notices[0].title).toBe('The space for your identity & messages is full')
  })

  it('a replacement keeps 0.5 xBZZ in the wallet', async () => {
    // cost at price 100, depth 18, 1 month = 100 × 518400 × 2^18 PLUR
    const cost = BigInt(100 * 518400) << BigInt(18)
    const exact = makeBee({ reserve: { depth: 17, utilizationRatio: 1 }, bzz: cost.toString() })

    await runSystemStampCheck(exact.fetch)
    expect(exact.buys).toHaveLength(0)
  })

  it('never buys on a lagging chain', async () => {
    const lagging = makeBee({ reserve: { depth: 17, bucketDepth: 16, utilizationRatio: 1 }, lag: 500 })

    await runSystemStampCheck(lagging.fetch)
    expect(lagging.buys).toHaveLength(0)
  })

  it('a failed buy: retries after an hour, not every minute; stops after 3 with one bell', async () => {
    const bee = makeBee({ reserve: { depth: 17, bucketDepth: 16, utilizationRatio: 1 }, buyStatus: 500 })
    const now = Date.now()
    const clock = jest.spyOn(Date, 'now')

    try {
      clock.mockReturnValue(now)
      expect(await runSystemStampCheck(bee.fetch)).toBe('failed')
      expect(await runSystemStampCheck(bee.fetch)).toBe('skipped')
      expect(bee.buys).toHaveLength(1)
      expect(bee.labels).toHaveLength(0) // nothing retired without a new reserve

      clock.mockReturnValue(now + 61 * 60_000)
      await runSystemStampCheck(bee.fetch)
      clock.mockReturnValue(now + 122 * 60_000)
      await runSystemStampCheck(bee.fetch)
      expect(bee.buys).toHaveLength(3)

      clock.mockReturnValue(now + 300 * 60_000)
      await runSystemStampCheck(bee.fetch)
      expect(bee.buys).toHaveLength(3)

      const stopped = loadNotifications().filter(n => n.title.startsWith('Couldn’t set up space'))

      expect(stopped).toHaveLength(1)
      expect(loadPurchases()).toHaveLength(0)
    } finally {
      clock.mockRestore()
    }
  })

  it('a restart during a purchase never buys twice', async () => {
    const bee = makeBee({ reserve: { depth: 17, bucketDepth: 16, utilizationRatio: 1 } })
    // The purchase was sent, then Nook stopped before Bee answered.
    writeFileSync(`${DATA}/system-stamp.json`, JSON.stringify({ buySentAt: Date.now() }))

    expect(await runSystemStampCheck(bee.fetch)).toBe('exists')
    expect(bee.buys).toHaveLength(0)
  })

  it('a restart clears a stopped purchase so it is tried again', async () => {
    jest.useFakeTimers()
    try {
      writeFileSync(`${DATA}/system-stamp.json`, JSON.stringify({ buyFailures: 3, lastBuyFailureAt: Date.now() }))
      startSystemStampMonitor()
      const bee = makeBee({ reserve: { depth: 17, bucketDepth: 16, utilizationRatio: 1 } })

      expect(await runSystemStampCheck(bee.fetch)).toBe('bought')
    } finally {
      jest.clearAllTimers()
      jest.useRealTimers()
    }
  })
})
