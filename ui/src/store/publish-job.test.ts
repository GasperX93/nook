import { beforeEach, describe, expect, it, vi } from 'vitest'

import { loadBoughtStamp, saveBoughtStamp, usePublishJob, type PublishJob } from './publish-job'

const job = (id: string): PublishJob => ({
  id,
  siteName: 'site',
  status: 'running',
  phase: 'Buying storage…',
  uploadProgress: null,
  tagUid: null,
  skippedBuy: false,
  feedEnabled: true,
  fileCount: 1,
  content: { name: 'site', entries: [], size: 0, indexDocument: 'index.html' },
  selection: { sizeIdx: 1, durationIdx: 1, driveName: '', feedTopic: '' },
})

describe('publish job (R7-5)', () => {
  beforeEach(() => usePublishJob.getState().clear())

  it('updates only the job it belongs to', () => {
    usePublishJob.getState().start(job('a'))
    usePublishJob.getState().patch('a', { phase: 'Creating the permanent address…' })
    usePublishJob.getState().patch('old', { status: 'failed' })

    expect(usePublishJob.getState().job).toMatchObject({
      id: 'a',
      status: 'running',
      phase: 'Creating the permanent address…',
    })
  })

  it('remembers bought-but-unused storage across reloads', () => {
    const store = new Map<string, string>()

    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => store.set(k, v),
      removeItem: (k: string) => store.delete(k),
    })
    saveBoughtStamp({ batchID: 'ab', sizeIdx: 1, durationIdx: 2 })
    expect(loadBoughtStamp()).toEqual({ batchID: 'ab', sizeIdx: 1, durationIdx: 2 })
    saveBoughtStamp(null)
    expect(loadBoughtStamp()).toBeNull()
    vi.unstubAllGlobals()
  })
})
