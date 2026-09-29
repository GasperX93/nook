import { describe, expect, it, vi } from 'vitest'

import { isDriveFullError, withUploadRetries } from './upload-retry'

const ready = async () => false

describe('withUploadRetries', () => {
  it('returns the first success', async () => {
    const run = vi.fn(async () => 'ref')

    await expect(withUploadRetries(run, { attempts: 3, delayMs: 0, pause: ready })).resolves.toBe('ref')
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('gives up after the counted attempts', async () => {
    const run = vi.fn(async () => {
      throw new Error('boom')
    })

    await expect(withUploadRetries(run, { attempts: 3, delayMs: 0, pause: ready })).rejects.toThrow('boom')
    expect(run).toHaveBeenCalledTimes(3)
  })

  it('stops at once on a full drive', async () => {
    const run = vi.fn(async () => {
      throw new Error('batch is overissued')
    })

    await expect(withUploadRetries(run, { attempts: 5, delayMs: 0, pause: ready })).rejects.toThrow('overissued')
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('waits out a Bee shutdown that still answers "ready" for a moment', async () => {
    // Stop pressed: the first copy fails while Bee still says ready, then Bee
    // is down for a while, then back.
    const states = [false, false, true, false]
    const pause = vi.fn(async () => states.shift() ?? false)
    let calls = 0
    const run = vi.fn(async () => {
      calls++

      if (calls === 1) throw new Error('connection reset')

      return 'ref'
    })

    await expect(withUploadRetries(run, { attempts: 2, delayMs: 0, pause })).resolves.toBe('ref')
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('does not count failures while Bee was down, up to the free retries', async () => {
    const pause = vi.fn(async () => true) // Bee keeps dropping
    const run = vi.fn(async () => {
      throw new Error('down')
    })

    await expect(withUploadRetries(run, { attempts: 2, delayMs: 0, pause, freeRetries: 3 })).rejects.toThrow('down')
    // 2 counted attempts + 3 free ones
    expect(run).toHaveBeenCalledTimes(5)
  })

  it('reports each retry', async () => {
    const onRetry = vi.fn()
    const run = vi.fn(async () => {
      throw new Error('x')
    })

    await expect(withUploadRetries(run, { attempts: 3, delayMs: 0, pause: ready, onRetry })).rejects.toThrow()
    expect(onRetry.mock.calls).toEqual([[1], [2]])
  })
})

describe('isDriveFullError', () => {
  it('spots overissued and 402', () => {
    expect(isDriveFullError(new Error('stamp overissued'))).toBe(true)
    expect(isDriveFullError(new Error('Request failed with status 402'))).toBe(true)
    expect(isDriveFullError(new Error('timeout'))).toBe(false)
  })
})
