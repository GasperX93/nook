/**
 * Website publishing as an app-wide job (R7-5). The wizard used to keep its
 * progress in component state: leaving the page mid-publish left no status
 * anywhere (only the storing step reached the sidebar) and coming back
 * started a fresh wizard. The publish itself always kept running — this
 * store is what makes it visible: the sidebar card and the wizard both read
 * it, so the progress (or the result) is there wherever the user goes.
 *
 * Storage bought by an attempt that then failed is remembered in
 * localStorage, so a retry — even after leaving the page or a reload — never
 * buys it twice.
 */
import { create } from 'zustand'

import type { FileEntry } from '../utils/directory'

export interface PublishResult {
  hash: string
  expiresAt: number
  feedManifestAddress?: string
  recordId: string
}

export interface PublishJob {
  id: string
  siteName: string
  status: 'running' | 'done' | 'failed'
  phase: string
  /** The last real step's phase — what a Paused/Resuming phase interrupted (R8-3). */
  stepPhase?: string
  uploadProgress: number | null
  tagUid: number | null
  skippedBuy: boolean
  feedEnabled: boolean
  fileCount: number
  result?: PublishResult
  error?: string
  /** What was being published — restores the options step after a failure. */
  content: { name: string; entries: FileEntry[]; size: number; indexDocument: string }
  selection: { sizeIdx: number; durationIdx: number; driveName: string; feedTopic: string }
}

interface PublishJobState {
  job: PublishJob | null
  start: (job: PublishJob) => void
  /** Update the job — only if it is still the one with this id. */
  patch: (jobId: string, changes: Partial<PublishJob>) => void
  clear: () => void
}

export const usePublishJob = create<PublishJobState>((set, get) => ({
  job: null,
  start: job => set({ job }),
  patch: (jobId, changes) => {
    const job = get().job

    if (job && job.id === jobId) set({ job: { ...job, ...changes } })
  },
  clear: () => set({ job: null }),
}))

/** The sidebar entry id for a publish job. */
export const publishTransferId = (jobId: string) => `pub:${jobId}`

/** Where the sidebar card leads: the wizard, told to show the job. */
export const PUBLISH_JOB_HREF = '/apps/website-publisher?job=1'

// ─── Bought-but-unused storage (survives navigation and reloads) ────────────

const BOUGHT_KEY = 'nook.publish.boughtStamp.v1'

export interface BoughtStamp {
  batchID: string
  sizeIdx: number
  durationIdx: number
}

export function loadBoughtStamp(): BoughtStamp | null {
  try {
    const raw = localStorage.getItem(BOUGHT_KEY)

    return raw ? (JSON.parse(raw) as BoughtStamp) : null
  } catch {
    return null
  }
}

export function saveBoughtStamp(stamp: BoughtStamp | null): void {
  try {
    if (stamp) localStorage.setItem(BOUGHT_KEY, JSON.stringify(stamp))
    else localStorage.removeItem(BOUGHT_KEY)
  } catch {
    // Storage unavailable — the in-memory copy still guards this session.
  }
}
