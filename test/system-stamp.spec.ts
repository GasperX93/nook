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

import { mkdirSync, rmSync } from 'fs'

import { getAutoExtendSettings } from '../src/extend-monitor'
import { getMode } from '../src/funding-monitor'
import { loadNotifications } from '../src/notifications'
import { loadPurchases } from '../src/purchases'
import { type BeeFetch, runSystemStampCheck, SYSTEM_STAMP_LABEL } from '../src/system-stamp'

// #130 contract: buy exactly one labeled system batch, only in light mode with
// a synced chain and sufficient funds; enable auto-renew; record everything.

const DATA = 'test/data/system-stamp-spec'
const BATCH = 'f'.repeat(64)

function cleanUp() {
  rmSync(DATA, { recursive: true, force: true })
  mkdirSync(DATA, { recursive: true })
  ;(getMode as jest.Mock).mockReturnValue('light')
}

function makeBee(overrides: { existing?: boolean; lag?: number; bzz?: string; buyStatus?: number }) {
  const buys: { path: string; headers: Record<string, string> }[] = []
  const fetch: BeeFetch = async (path, init) => {
    if (path.startsWith('/stamps') && init?.method === 'POST') {
      buys.push({ path, headers: (init.headers ?? {}) as Record<string, string> })

      if (overrides.buyStatus) return new Response('{}', { status: overrides.buyStatus })

      return new Response(JSON.stringify({ batchID: BATCH }), { status: 200 })
    }

    if (path.startsWith('/stamps')) {
      const stamps = overrides.existing ? [{ batchID: BATCH, label: SYSTEM_STAMP_LABEL }] : []

      return new Response(JSON.stringify({ stamps }), { status: 200 })
    }

    if (path.startsWith('/chainstate')) {
      return new Response(
        JSON.stringify({ chainTip: 1000, block: 1000 - (overrides.lag ?? 0), currentPrice: '100' }),
        { status: 200 },
      )
    }

    if (path.startsWith('/wallet')) {
      return new Response(JSON.stringify({ bzzBalance: overrides.bzz ?? '99999999999999999' }), { status: 200 })
    }

    return new Response('{}', { status: 404 })
  }

  return { fetch, buys }
}

beforeEach(cleanUp)
afterAll(cleanUp)

describe('system stamp (#130)', () => {
  it('buys once with the right shape: label, depth 17, immutable, 3 months of price', async () => {
    const bee = makeBee({})
    const result = await runSystemStampCheck(bee.fetch)

    expect(result).toBe('bought')
    expect(bee.buys).toHaveLength(1)
    // amount per chunk = price 100 × 518400 blocks/mo × 3 months
    expect(bee.buys[0].path).toBe(`/stamps/${100 * 518400 * 3}/17?label=${SYSTEM_STAMP_LABEL}`)
    expect(bee.buys[0].headers.immutable).toBe('true')

    // Auto-renew ON by default, matching the purchase duration
    expect(getAutoExtendSettings()[BATCH]).toMatchObject({ enabled: true, months: 3 })

    // Ledger + bell record
    expect(loadPurchases()[0]).toMatchObject({ kind: 'create', batchId: BATCH, label: SYSTEM_STAMP_LABEL })
    expect(loadNotifications()[0].title).toContain('identity & messages')
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
    expect(notices[0].title).toContain('2 xBZZ')
    expect(notices[0].link).toBe('/account')

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
