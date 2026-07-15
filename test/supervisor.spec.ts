jest.mock('env-paths', () =>
  jest.fn().mockImplementation(() => ({
    data: 'test/data',
    config: 'test/data',
    cache: 'test/data',
    log: 'test/data',
    temp: 'test/data',
  })),
)

import {
  canAttemptStart,
  getSupervisorStatus,
  recordExit,
  recordStart,
  resetCrashLoop,
  shouldRestartForWedge,
} from '../src/supervisor'

const MIN = 60_000

function probes(peerCount: number | null, internet = true) {
  return {
    getPeerCount: async () => peerCount,
    hasInternet: async () => internet,
  }
}

describe('supervisor', () => {
  beforeEach(() => resetCrashLoop())

  test('healthy run resets crash accounting', () => {
    let t = 0
    recordStart(t)
    recordExit((t += 2 * MIN)) // uptime 2min = healthy
    expect(canAttemptStart(t)).toBe(true)
    expect(getSupervisorStatus().consecutiveFastCrashes).toBe(0)
  })

  test('fast crashes back off exponentially', () => {
    let t = 0
    recordStart(t)
    recordExit((t += 5_000)) // crash 1 → wait 20s
    expect(canAttemptStart(t + 10_000)).toBe(false)
    expect(canAttemptStart(t + 21_000)).toBe(true)

    recordStart((t += 21_000))
    recordExit((t += 5_000)) // crash 2 → wait 40s
    expect(canAttemptStart(t + 30_000)).toBe(false)
    expect(canAttemptStart(t + 41_000)).toBe(true)
  })

  test('a long run after crashes resets the ladder', () => {
    let t = 0
    recordStart(t)
    recordExit((t += 5_000)) // crash 1
    recordStart((t += 30_000))
    recordExit((t += 2 * MIN)) // healthy
    expect(getSupervisorStatus().consecutiveFastCrashes).toBe(0)
    expect(canAttemptStart(t)).toBe(true)
  })

  test('5 consecutive fast crashes trip the crash loop; reset forgives', () => {
    let t = 0

    for (let i = 0; i < 5; i++) {
      recordStart(t)
      recordExit((t += 5_000))
      t += 10 * MIN // wait out any backoff
    }
    expect(getSupervisorStatus().crashLoop).toBe(true)
    expect(canAttemptStart(t)).toBe(false)

    resetCrashLoop()
    expect(getSupervisorStatus().crashLoop).toBe(false)
    expect(canAttemptStart(t)).toBe(true)
  })

  describe('wedge detection', () => {
    test('no restart during warmup grace', async () => {
      recordStart(0)
      expect(await shouldRestartForWedge(2 * MIN, probes(0))).toBe(false)
    })

    test('0 peers must persist past the limit before restarting', async () => {
      recordStart(0)
      // Past grace, first zero-peers observation only arms the timer
      expect(await shouldRestartForWedge(6 * MIN, probes(0))).toBe(false)
      // Still within the 5-minute window
      expect(await shouldRestartForWedge(8 * MIN, probes(0))).toBe(false)
      // Past the window with internet up → restart
      expect(await shouldRestartForWedge(12 * MIN, probes(0))).toBe(true)
    })

    test('peers recovering disarms the timer', async () => {
      recordStart(0)
      expect(await shouldRestartForWedge(6 * MIN, probes(0))).toBe(false)
      expect(await shouldRestartForWedge(8 * MIN, probes(30))).toBe(false) // recovered
      expect(await shouldRestartForWedge(14 * MIN, probes(0))).toBe(false) // re-arms fresh
    })

    test('no internet → no restart (nothing to fix)', async () => {
      recordStart(0)
      expect(await shouldRestartForWedge(6 * MIN, probes(0, false))).toBe(false)
      expect(await shouldRestartForWedge(12 * MIN, probes(0, false))).toBe(false)
    })

    test('unreachable API is not a wedge (crash detection owns that)', async () => {
      recordStart(0)
      expect(await shouldRestartForWedge(6 * MIN, probes(null))).toBe(false)
      expect(await shouldRestartForWedge(12 * MIN, probes(null))).toBe(false)
    })

    test('after a wedge restart the timer starts clean', async () => {
      recordStart(0)
      await shouldRestartForWedge(6 * MIN, probes(0))
      expect(await shouldRestartForWedge(12 * MIN, probes(0))).toBe(true)
      // New run
      recordStart(13 * MIN)
      expect(await shouldRestartForWedge(19 * MIN, probes(0))).toBe(false) // arms only
    })
  })
})
