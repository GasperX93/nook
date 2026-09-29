import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Readiness comes from Nook's backend; each test decides what it answers.
const readiness = vi.fn()

vi.mock('./client', () => ({ api: { getBeeReadiness: () => readiness() } }))
// The app store touches localStorage at import; this module doesn't need it.
vi.mock('../store/app', () => ({ useAppStore: { getState: () => ({}) } }))

import { waitForTagPropagation, waitWhileBeeDown } from './bee'

type Step = { tag: { split: number; seen: number; synced: number } } | 'down' | 'error'

/** Scripted /tags answers; the last step repeats. */
function scriptTags(steps: Step[]) {
  let i = 0

  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      const step = steps[Math.min(i++, steps.length - 1)]

      if (step === 'down') throw new TypeError('Failed to fetch')

      if (step === 'error') return new Response('boom', { status: 500 })

      return new Response(JSON.stringify({ uid: 1, sent: 0, ...step.tag }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }),
  )
}

const tag = (synced: number) => ({ tag: { split: 100, seen: 0, synced } })

beforeEach(() => {
  readiness.mockReset()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('waitForTagPropagation (R5-13)', () => {
  it('keeps following through a Bee restart and completes once Bee finishes the push', async () => {
    // Progress, then Bee unreachable for longer than the stall limit, then done.
    scriptTags([tag(1), ...Array(80).fill('down'), tag(50), tag(100)])
    readiness.mockResolvedValue({ ready: true })

    const res = await waitForTagPropagation(1, undefined, { pollMs: 0, maxStalledPolls: 60 })

    expect(res.complete).toBe(true)
  })

  it('reports waiting while Bee is down and clears it once pieces land again (R6-3)', async () => {
    scriptTags([tag(1), 'down', 'down', tag(50), tag(100)])
    readiness.mockResolvedValue({ ready: true })
    const onWaiting = vi.fn()

    await waitForTagPropagation(1, undefined, { pollMs: 0, onWaiting })

    expect(onWaiting.mock.calls).toEqual([['node'], [null]])
  })

  it('starts the no-progress count over after an outage', async () => {
    // 55 polls without progress, Bee down, then back without progress for a
    // while before the push resumes — must not give up in between.
    scriptTags([tag(1), ...Array(55).fill(tag(1)), 'down', 'down', ...Array(20).fill(tag(1)), tag(100)])
    readiness.mockResolvedValue({ ready: true })

    const res = await waitForTagPropagation(1, undefined, { pollMs: 0, maxStalledPolls: 60 })

    expect(res.complete).toBe(true)
  })

  it('says "resuming" while Bee is ready again but nothing moves yet (R7-1)', async () => {
    // Down, then back and ready but no progress for a while, then progress.
    scriptTags([tag(1), 'down', ...Array(90).fill(tag(1)), tag(40), tag(100)])
    readiness.mockResolvedValue({ ready: true })
    const onWaiting = vi.fn()

    const res = await waitForTagPropagation(1, undefined, { pollMs: 0, maxStalledPolls: 60, onWaiting })

    // No flip-flop, and it did not give up during the 90 quiet polls.
    expect(onWaiting.mock.calls).toEqual([['node'], ['resuming'], [null]])
    expect(res.complete).toBe(true)
  })

  it('stays "paused" while Bee answers but is not ready yet', async () => {
    scriptTags([tag(1), 'down', ...Array(5).fill(tag(1)), tag(100)])
    readiness.mockResolvedValue({ ready: false })
    const onWaiting = vi.fn()

    await waitForTagPropagation(1, undefined, { pollMs: 0, onWaiting })

    expect(onWaiting.mock.calls).toEqual([['node']])
  })

  it('does not call it a stall while Bee is up but not ready (re-syncing)', async () => {
    // No progress for 100 polls while Bee reports not ready, then progress resumes.
    scriptTags([tag(1), ...Array(100).fill(tag(1)), tag(100)])
    readiness.mockResolvedValue({ ready: false })

    const res = await waitForTagPropagation(1, undefined, { pollMs: 0, maxStalledPolls: 60 })

    expect(res.complete).toBe(true)
  })

  it('still gives up on a genuine stall when Bee is ready', async () => {
    scriptTags([tag(1), tag(1)])
    readiness.mockResolvedValue({ ready: true })

    const res = await waitForTagPropagation(1, undefined, { pollMs: 0, maxStalledPolls: 60 })

    expect(res.complete).toBe(false)
    expect(res.tag?.synced).toBe(1)
  })

  it('stops waiting on a Bee that stays down beyond the bound', async () => {
    scriptTags([tag(1), 'down'])
    readiness.mockResolvedValue({ ready: false })

    const res = await waitForTagPropagation(1, undefined, { pollMs: 0, maxNotReadyMs: 0 })

    expect(res.complete).toBe(false)
  })

  it('counts Bee errors (not outages) as stalls', async () => {
    scriptTags(['error'])
    readiness.mockResolvedValue({ ready: true })

    const res = await waitForTagPropagation(1, undefined, { pollMs: 0, maxStalledPolls: 5 })

    expect(res.complete).toBe(false)
  })
})

describe('waitWhileBeeDown (R8-3)', () => {
  it('returns at once, without reporting, when Bee is ready', async () => {
    readiness.mockResolvedValue({ ready: true })
    const onWait = vi.fn()

    expect(await waitWhileBeeDown(onWait, { pollMs: 0 })).toBe(false)
    expect(onWait).not.toHaveBeenCalled()
  })

  it('pauses while Bee is down or not ready, then says it is resuming', async () => {
    readiness
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce({ ready: false })
      .mockResolvedValue({ ready: true })
    const onWait = vi.fn()

    expect(await waitWhileBeeDown(onWait, { pollMs: 0 })).toBe(true)
    expect(onWait.mock.calls).toEqual([['node'], ['resuming']])
  })

  it('gives up on a Bee that stays down beyond the bound', async () => {
    readiness.mockResolvedValue({ ready: false })

    await expect(waitWhileBeeDown(undefined, { pollMs: 0, maxMs: 0 })).rejects.toThrow('unavailable')
  })
})
