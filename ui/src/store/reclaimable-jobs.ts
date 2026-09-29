/**
 * Deletable-drive upload jobs, followed OUTSIDE the drive view — like the
 * classic uploads' tag following (store/transfers). The job itself runs in
 * Nook's backend and never depended on the page; only its progress did: the
 * polling lived in the drive component, so leaving the drive froze the
 * sidebar entry and a revisit showed "No files yet" while the upload kept
 * going.
 *
 * Here one poller per job feeds the global tracker (`rjob:<id>` entries), so
 * the sidebar reaches 100% from any page and the drive view re-attaches its
 * panel to a running job. Jobs are also remembered in localStorage, so a
 * reloaded dashboard picks them up again (the backend keeps finished jobs for
 * an hour; after an app restart they're gone and the entry is dropped).
 */
import { serverApi, type ReclaimableUploadJob } from '../api/server'
import { friendlyError } from '../lib/friendly-error'
import { useTransfersStore } from './transfers'

export interface ReclaimableJobMeta {
  uploadId: string
  name: string
  driveId: string
  /** Estimated pieces — the job only counts confirmed ones. */
  estimate: number
  /** Folder the upload was started in — the file is moved there when done. */
  folderId: string | null
}

const STORAGE_KEY = 'nook.reclaimableJobs.v1'
const POLL_MS = 1000

const following = new Set<string>()

export function reclaimableJobTransferId(uploadId: string): string {
  return `rjob:${uploadId}`
}

function load(): ReclaimableJobMeta[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]') as unknown

    return Array.isArray(parsed) ? (parsed as ReclaimableJobMeta[]) : []
  } catch {
    return []
  }
}

function save(jobs: ReclaimableJobMeta[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(jobs))
  } catch {
    // Storage full or blocked — following still works for this session.
  }
}

function forget(uploadId: string): void {
  save(load().filter(j => j.uploadId !== uploadId))
}

/** Follow a job until it ends. Safe to call twice — one poller per job. */
export function followReclaimableJob(meta: ReclaimableJobMeta): void {
  if (!load().some(j => j.uploadId === meta.uploadId)) save([...load(), meta])

  if (following.has(meta.uploadId)) return
  following.add(meta.uploadId)

  const id = reclaimableJobTransferId(meta.uploadId)
  const store = useTransfersStore.getState()

  if (!store.transfers.some(t => t.id === id)) {
    store.begin({ id, kind: 'upload', name: meta.name, driveId: meta.driveId, phase: 'Storing on the network…' })
  }

  void poll(meta, id)
}

async function poll(meta: ReclaimableJobMeta, id: string): Promise<void> {
  try {
    for (;;) {
      let job: ReclaimableUploadJob

      try {
        job = await serverApi.getReclaimableUpload(meta.uploadId)
      } catch (err) {
        // The backend forgot the job (Nook restarted, or finished over an
        // hour ago): nothing left to follow. Anything else is transient.
        if (err instanceof Error && /unknown upload/i.test(err.message)) {
          useTransfersStore.getState().remove(id)
          forget(meta.uploadId)

          return
        }
        await sleep(POLL_MS * 3)
        continue
      }

      if (meta.estimate > 0) {
        useTransfersStore.getState().chunkProgress(id, job.chunksUploaded, meta.estimate)
      }

      if (job.status !== 'uploading') {
        if (job.status === 'done' && meta.folderId && job.reference) {
          await serverApi.moveReclaimableFile(meta.driveId, job.reference, meta.folderId).catch(() => undefined)
        }

        if (job.status === 'error') {
          // The drive view shows the phase of a failed job as its error.
          useTransfersStore.getState().update(id, { phase: friendlyError(job.error, 'Upload failed') })
        }
        useTransfersStore.getState().finish(id, job.status === 'error' ? 'failed' : 'done')
        forget(meta.uploadId)

        return
      }
      await sleep(POLL_MS)
    }
  } finally {
    following.delete(meta.uploadId)
  }
}

/** Re-attach to jobs still running when the dashboard was last closed. Mounted once from Layout. */
export function resumeReclaimableJobs(): void {
  load().forEach(followReclaimableJob)
}

async function sleep(ms: number): Promise<void> {
  await new Promise(r => setTimeout(r, ms))
}
