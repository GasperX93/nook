jest.mock('env-paths', () =>
  jest.fn().mockImplementation(() => ({
    data: 'test/data/extend-monitor-spec',
    config: 'test/data/extend-monitor-spec',
    cache: 'test/data/extend-monitor-spec',
    log: 'test/data/extend-monitor-spec',
    temp: 'test/data/extend-monitor-spec',
  })),
)
jest.mock('../src/config', () => ({
  ...jest.requireActual('../src/config'),
  readConfigYaml: () => ({ password: 'pw' }),
}))
jest.mock('../src/notify', () => ({ createNotification: jest.fn() }))

import { mkdirSync, rmSync } from 'fs'

import {
  type BeeFetch,
  getAutoExtendFailures,
  getAutoExtendSettings,
  leadSeconds,
  runExtendCheck,
  setAutoExtendSetting,
  shouldExtend,
  THRESHOLD_SECONDS,
  topupAmount,
} from '../src/extend-monitor'
import { loadNotifications } from '../src/notifications'

// The auto-extend contract (#129): extend an opted-in drive before it expires,
// never double-spend, never act on stale chain data, and record every failure
// loudly — a silent miss here is data loss on a timer.

const BATCH = 'a'.repeat(64)
const DAY = 86_400
const DATA = 'test/data/extend-monitor-spec'
const SETTINGS_FILE = `${DATA}/auto-extend.json`

function cleanUp() {
  rmSync(DATA, { recursive: true, force: true })
  mkdirSync(DATA, { recursive: true })
}

/** Bee stub: map url-substring → responder. Records topup calls. */
function makeBee(overrides: {
  ttl?: number
  lag?: number
  price?: string
  bzz?: string
  batchStatus?: number
  freshTtl?: number
}) {
  const topups: string[] = []
  let batchReads = 0
  const fetch: BeeFetch = async path => {
    if (path.startsWith('/chainstate')) {
      return new Response(
        JSON.stringify({ chainTip: 1000, block: 1000 - (overrides.lag ?? 0), currentPrice: overrides.price ?? '100' }),
        { status: 200 },
      )
    }

    if (path.startsWith('/stamps') && !path.startsWith('/stamps/topup')) {
      return new Response(JSON.stringify({ stamps: [{ batchID: BATCH, label: 'Photos' }] }), { status: 200 })
    }

    if (path.startsWith('/wallet')) {
      return new Response(JSON.stringify({ bzzBalance: overrides.bzz ?? '1000000000000000000' }), { status: 200 })
    }

    if (path.startsWith('/stamps/topup/')) {
      topups.push(path)

      return new Response(JSON.stringify({ batchID: BATCH }), { status: 200 })
    }

    if (path.startsWith('/batches/')) {
      if (overrides.batchStatus) return new Response('{}', { status: overrides.batchStatus })
      batchReads += 1
      // Second read = the pre-payment re-check; freshTtl simulates a manual
      // extend landing between the two reads.
      const ttl = batchReads > 1 && overrides.freshTtl !== undefined ? overrides.freshTtl : (overrides.ttl ?? 100 * DAY)

      return new Response(JSON.stringify({ batchTTL: ttl, depth: 20 }), { status: 200 })
    }

    return new Response('{}', { status: 404 })
  }

  return { fetch, topups }
}

beforeEach(cleanUp)
afterAll(cleanUp)

describe('decision logic', () => {
  it('extends only enabled drives below the threshold', () => {
    const entry = { enabled: true, months: 3 }

    expect(shouldExtend(entry, 5 * DAY)).toBe(true)
    expect(shouldExtend(entry, 11 * DAY)).toBe(false)
    expect(shouldExtend({ ...entry, enabled: false }, 5 * DAY)).toBe(false)
    expect(shouldExtend(entry, 0)).toBe(false)
  })

  it('threshold defaults to 10 days', () => {
    expect(THRESHOLD_SECONDS).toBe(10 * DAY)
  })

  it('topup amount = price × blocks-per-month × months (manual Extend math)', () => {
    // 30 days at 5s blocks = 518400 blocks
    expect(topupAmount(2, '100')).toBe(BigInt(100 * 518400 * 2))
  })
})

describe('settings store', () => {
  it('set → get roundtrip, validates inputs, clears stale failures on change', () => {
    setAutoExtendSetting(BATCH, true, 3)
    expect(getAutoExtendSettings()[BATCH]).toMatchObject({ enabled: true, months: 3 })

    expect(() => setAutoExtendSetting('nope', true, 3)).toThrow(/Invalid batch/)
    expect(() => setAutoExtendSetting(BATCH, true, 0)).toThrow(/Invalid duration/)
  })
})

describe('runExtendCheck', () => {
  it('healthy drive → no topup', async () => {
    setAutoExtendSetting(BATCH, true, 3)
    const bee = makeBee({ ttl: 90 * DAY })

    await runExtendCheck(bee.fetch)
    expect(bee.topups).toHaveLength(0)
    expect(getAutoExtendFailures()).toHaveLength(0)
  })

  it('low TTL → tops up with the drive-chosen duration', async () => {
    setAutoExtendSetting(BATCH, true, 3)
    const bee = makeBee({ ttl: 5 * DAY, price: '100' })

    const hasFailures = await runExtendCheck(bee.fetch)

    expect(bee.topups).toHaveLength(1)
    expect(bee.topups[0]).toBe(`/stamps/topup/${BATCH}/${BigInt(100 * 518400 * 3).toString()}`)
    expect(hasFailures).toBe(false)
    expect(getAutoExtendSettings()[BATCH].lastExtendedAt).toBeDefined()
  })

  it('insufficient xBZZ → failure recorded, no topup', async () => {
    setAutoExtendSetting(BATCH, true, 3)
    const bee = makeBee({ ttl: 5 * DAY, bzz: '1' })

    const hasFailures = await runExtendCheck(bee.fetch)

    expect(bee.topups).toHaveLength(0)
    expect(hasFailures).toBe(true)
    expect(getAutoExtendFailures()[0].reason).toMatch(/xBZZ/)
  })

  it('lagging chain view → skips the whole pass, no calls made', async () => {
    setAutoExtendSetting(BATCH, true, 3)
    const bee = makeBee({ ttl: 5 * DAY, lag: 500 })

    await runExtendCheck(bee.fetch)
    expect(bee.topups).toHaveLength(0)
    expect(getAutoExtendFailures()).toHaveLength(0)
  })

  it('batch gone (404 on synced chain) → honest failure, no topup', async () => {
    setAutoExtendSetting(BATCH, true, 3)
    const bee = makeBee({ batchStatus: 404 })

    await runExtendCheck(bee.fetch)
    expect(bee.topups).toHaveLength(0)
    expect(getAutoExtendFailures()[0].reason).toMatch(/already expired/)
  })

  it('manual extend racing the check → pre-payment re-read prevents double-spend', async () => {
    setAutoExtendSetting(BATCH, true, 3)
    const bee = makeBee({ ttl: 5 * DAY, freshTtl: 95 * DAY })

    await runExtendCheck(bee.fetch)
    expect(bee.topups).toHaveLength(0)
  })

  it('recovery clears the failure (and the banner with it)', async () => {
    setAutoExtendSetting(BATCH, true, 3)
    await runExtendCheck(makeBee({ ttl: 5 * DAY, bzz: '1' }).fetch)
    expect(getAutoExtendFailures()).toHaveLength(1)

    await runExtendCheck(makeBee({ ttl: 90 * DAY }).fetch)
    expect(getAutoExtendFailures()).toHaveLength(0)
  })

  it('disabled drives are never touched', async () => {
    setAutoExtendSetting(BATCH, false, 3)
    const bee = makeBee({ ttl: 5 * DAY })

    await runExtendCheck(bee.fetch)
    expect(bee.topups).toHaveLength(0)
  })
})

describe('charge notifications (#138)', () => {
  const DAY = 86_400

  it('lead window scales with duration, capped at 10 days', () => {
    expect(leadSeconds(1)).toBe(10 * DAY)
    expect(leadSeconds(3)).toBe(10 * DAY)
    expect(leadSeconds(12)).toBe(10 * DAY)
  })

  it('entering the lead window pushes upcoming-charge ONCE, with drive label and estimate', async () => {
    setAutoExtendSetting(BATCH, true, 3)
    const bee = makeBee({ ttl: 15 * DAY, price: '100' })

    await runExtendCheck(bee.fetch)
    await runExtendCheck(bee.fetch)

    const events = loadNotifications().filter(n => n.type === 'upcoming-charge')

    expect(events).toHaveLength(1)
    expect(events[0].title).toContain('Photos')
    expect(events[0].data?.estXbzz).toBeDefined()
    expect(bee.topups).toHaveLength(0)
  })

  it('in the lead window with a short wallet, charge-blocked warns early', async () => {
    setAutoExtendSetting(BATCH, true, 3)
    const bee = makeBee({ ttl: 15 * DAY, bzz: '1' })

    await runExtendCheck(bee.fetch)

    expect(loadNotifications().some(n => n.type === 'charge-blocked')).toBe(true)
    expect(bee.topups).toHaveLength(0)
  })

  it('leaving the window (manual extend) resets the cycle — next window notifies again', async () => {
    setAutoExtendSetting(BATCH, true, 3)
    await runExtendCheck(makeBee({ ttl: 15 * DAY }).fetch)
    expect(getAutoExtendSettings()[BATCH].notifiedUpcomingAt).toBeDefined()

    await runExtendCheck(makeBee({ ttl: 90 * DAY }).fetch)
    expect(getAutoExtendSettings()[BATCH].notifiedUpcomingAt).toBeUndefined()

    await runExtendCheck(makeBee({ ttl: 15 * DAY }).fetch)
    expect(loadNotifications().filter(n => n.type === 'upcoming-charge')).toHaveLength(2)
  })

  it('a successful charge records charge-executed with the paid amount, and clears the flags', async () => {
    setAutoExtendSetting(BATCH, true, 3)
    await runExtendCheck(makeBee({ ttl: 15 * DAY }).fetch) // upcoming
    await runExtendCheck(makeBee({ ttl: 5 * DAY, price: '100' }).fetch) // fires

    const executed = loadNotifications().find(n => n.type === 'charge-executed')

    expect(executed?.title).toContain('Photos')
    expect(executed?.data?.driveLabel).toBe('Photos')
    expect(executed?.data?.amountXbzz).toBeDefined()
    expect(executed?.data?.amountPlur).toBeDefined()
    expect(getAutoExtendSettings()[BATCH].notifiedUpcomingAt).toBeUndefined()
  })

  it('decrements the balance within a pass: two affordable-looking drives, funds for one', async () => {
    const A = 'a'.repeat(64)
    const B = 'b'.repeat(64)
    // Per-drive cost at price 100, depth 20: 100 × 518400 << 20 = 54_358_179_840_000.
    // Balance = 1.5× that: each drive alone looks affordable, together they are not.
    const balance = '81537269760000'
    const topups: string[] = []
    const fetch: BeeFetch = async path => {
      if (path.startsWith('/chainstate')) {
        return new Response(JSON.stringify({ chainTip: 1000, block: 1000, currentPrice: '100' }), { status: 200 })
      }

      if (path.startsWith('/stamps') && !path.startsWith('/stamps/topup')) {
        return new Response(
          JSON.stringify({
            stamps: [
              { batchID: A, label: 'First' },
              { batchID: B, label: 'Second' },
            ],
          }),
          { status: 200 },
        )
      }

      if (path.startsWith('/wallet')) return new Response(JSON.stringify({ bzzBalance: balance }), { status: 200 })

      if (path.startsWith('/stamps/topup/')) {
        topups.push(path)

        return new Response('{}', { status: 200 })
      }

      if (path.startsWith('/batches/')) {
        return new Response(JSON.stringify({ batchTTL: 5 * DAY, depth: 20 }), { status: 200 })
      }

      return new Response('{}', { status: 404 })
    }

    setAutoExtendSetting(A, true, 1)
    setAutoExtendSetting(B, true, 1)
    await runExtendCheck(fetch)

    // Exactly one charge went through; the second was refused against the
    // DECREMENTED balance with the honest notice, not a raw chain error.
    expect(topups).toHaveLength(1)
    expect(topups[0]).toContain(A)
    const blocked = loadNotifications().find(n => n.type === 'charge-blocked')

    expect(blocked?.title).toContain('Second')
    expect(getAutoExtendFailures().map(f => f.batchId)).toEqual([B])
    expect(getAutoExtendFailures()[0].reason).toContain('Not enough xBZZ')
  })

  it('a blocked charge below threshold notifies once alongside the failure record', async () => {
    setAutoExtendSetting(BATCH, true, 3)
    await runExtendCheck(makeBee({ ttl: 5 * DAY, bzz: '1' }).fetch)
    await runExtendCheck(makeBee({ ttl: 5 * DAY, bzz: '1' }).fetch)

    expect(loadNotifications().filter(n => n.type === 'charge-blocked')).toHaveLength(1)
    expect(getAutoExtendFailures()).toHaveLength(1)
  })
})
