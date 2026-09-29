// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const getReclaimableUpload = vi.fn()
const moveReclaimableFile = vi.fn(async () => undefined)

vi.mock('../api/server', () => ({
  serverApi: {
    getReclaimableUpload: async (id: string) => getReclaimableUpload(id),
    moveReclaimableFile: async (...args: unknown[]) => moveReclaimableFile(...(args as [])),
    createNotification: vi.fn(async () => undefined),
  },
}))

import { followReclaimableJob, reclaimableJobTransferId, resumeReclaimableJobs } from './reclaimable-jobs'
import { useTransfersStore } from './transfers'

const meta = { uploadId: 'u1', name: 'movie.mov', driveId: 'batch1', estimate: 100, folderId: null }
const entry = () => useTransfersStore.getState().transfers.find(t => t.id === reclaimableJobTransferId('u1'))
const stored = () => JSON.parse(localStorage.getItem('nook.reclaimableJobs.v1') ?? '[]') as unknown[]

async function flush(ms = 1000) {
  await vi.advanceTimersByTimeAsync(ms)
}

describe('reclaimable upload jobs, followed outside the drive view', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    localStorage.clear()
    useTransfersStore.setState({ transfers: [] })
    getReclaimableUpload.mockReset()
    moveReclaimableFile.mockClear()
  })

  it('feeds the sidebar entry until the job is done, then forgets it', async () => {
    getReclaimableUpload
      .mockResolvedValueOnce({ status: 'uploading', chunksUploaded: 35 })
      .mockResolvedValueOnce({ status: 'done', chunksUploaded: 100, reference: 'ref' })

    followReclaimableJob(meta)
    expect(stored()).toHaveLength(1)
    await flush(0)
    expect(entry()?.pct).toBe(35)

    await flush()
    expect(entry()?.status).toBe('done')
    expect(stored()).toHaveLength(0)
  })

  it('moves the file into the folder it was uploaded in', async () => {
    getReclaimableUpload.mockResolvedValue({ status: 'done', chunksUploaded: 100, reference: 'ref' })

    followReclaimableJob({ ...meta, folderId: 'f1' })
    await flush(0)
    expect(moveReclaimableFile).toHaveBeenCalledWith('batch1', 'ref', 'f1')
  })

  it('reports a failed job with its reason', async () => {
    getReclaimableUpload.mockResolvedValue({ status: 'error', chunksUploaded: 3, error: 'bucket full' })

    followReclaimableJob(meta)
    await flush(0)
    expect(entry()?.status).toBe('failed')
    expect(entry()?.phase).toBe('bucket full')
  })

  it('drops a job the backend no longer knows (Nook restarted)', async () => {
    getReclaimableUpload.mockRejectedValue(new Error('Unknown upload'))

    followReclaimableJob(meta)
    await flush(0)
    expect(entry()).toBeUndefined()
    expect(stored()).toHaveLength(0)
  })

  it('keeps following through a transient poll failure', async () => {
    getReclaimableUpload
      .mockRejectedValueOnce(new Error('Failed to fetch'))
      .mockResolvedValueOnce({ status: 'done', chunksUploaded: 100, reference: 'ref' })

    followReclaimableJob(meta)
    await flush(0)
    expect(entry()?.status).toBe('active')
    await flush(3000)
    expect(entry()?.status).toBe('done')
  })

  it('resumes remembered jobs after a reload, one poller each', async () => {
    localStorage.setItem('nook.reclaimableJobs.v1', JSON.stringify([meta]))
    getReclaimableUpload.mockResolvedValue({ status: 'uploading', chunksUploaded: 10 })

    resumeReclaimableJobs()
    followReclaimableJob(meta) // the drive view re-attaching must not start a second poller
    await flush(0)
    expect(getReclaimableUpload).toHaveBeenCalledTimes(1)
    expect(entry()?.pct).toBe(10)
  })
})
