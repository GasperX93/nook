/**
 * Global transfer tracker (#4/#5 test-run batch): uploads propagating to the
 * network and downloads in flight, tracked OUTSIDE page components so leaving
 * the page never hides a running transfer. The sidebar indicator and the
 * Drive rows both read from here; revisiting a page re-attaches to whatever
 * is still running because the async work updates this store, not local state.
 *
 * Propagation entries additionally persist their Bee tag uid to localStorage:
 * tags live on the node, so a closed-and-reopened dashboard can resume
 * following an unfinished propagation (resumePendingPropagation, mounted from
 * Layout).
 */
import { create } from 'zustand'

import { waitForTagPropagation } from '../api/bee'
import { serverApi } from '../api/server'

export interface TransferEntry {
  id: string
  kind: 'upload' | 'download'
  name: string
  driveId?: string
  phase: string
  /** 0–100, or null while indeterminate */
  pct: number | null
  chunksDone?: number
  chunksTotal?: number
  status: 'active' | 'done' | 'failed'
  startedAt: number
  /** Rolling [timestampMs, chunksDone] samples for the rate/ETA estimate. */
  samples: [number, number][]
}

interface TransfersState {
  transfers: TransferEntry[]
  begin: (t: Pick<TransferEntry, 'id' | 'kind' | 'name'> & Partial<Pick<TransferEntry, 'driveId' | 'phase'>>) => void
  update: (id: string, changes: Partial<Pick<TransferEntry, 'phase' | 'pct'>>) => void
  /** Progress in chunks — also feeds the rate samples for the ETA. */
  chunkProgress: (id: string, done: number, total: number) => void
  finish: (id: string, status?: 'done' | 'failed') => void
}

const SAMPLE_WINDOW_MS = 90_000
const DONE_LINGER_MS = 4_000

export const useTransfersStore = create<TransfersState>((set, get) => ({
  transfers: [],

  begin: t =>
    set(state => ({
      transfers: [
        ...state.transfers.filter(x => x.id !== t.id),
        { pct: null, phase: '', ...t, status: 'active', startedAt: Date.now(), samples: [] },
      ],
    })),

  update: (id, changes) =>
    set(state => ({ transfers: state.transfers.map(t => (t.id === id ? { ...t, ...changes } : t)) })),

  chunkProgress: (id, done, total) =>
    set(state => ({
      transfers: state.transfers.map(t => {
        if (t.id !== id) return t
        const now = Date.now()
        const samples = [...t.samples, [now, done] as [number, number]].filter(([ts]) => now - ts <= SAMPLE_WINDOW_MS)

        return {
          ...t,
          chunksDone: done,
          chunksTotal: total,
          pct: total > 0 ? Math.min(Math.round((done / total) * 100), 100) : t.pct,
          samples,
        }
      }),
    })),

  finish: (id, status = 'done') => {
    set(state => ({ transfers: state.transfers.map(t => (t.id === id ? { ...t, status, pct: 100 } : t)) }))
    // Linger briefly so "done" is visible, then drop the entry.
    setTimeout(() => {
      set(state => ({ transfers: state.transfers.filter(t => t.id !== id) }))
    }, DONE_LINGER_MS)
    void get
  },
}))

/**
 * Coarse, honest time estimate from the rolling chunk-rate. Never a ticking
 * countdown: needs ≥30s of samples, rounds hard, and returns null when the
 * rate collapses (the stall path owns that story).
 */
export function etaText(t: TransferEntry): string | null {
  if (t.chunksTotal === undefined || t.chunksDone === undefined || t.samples.length < 2) return null
  const [firstTs, firstDone] = t.samples[0]
  const [lastTs, lastDone] = t.samples[t.samples.length - 1]
  const spanMs = lastTs - firstTs

  if (spanMs < 30_000) return null
  const rate = (lastDone - firstDone) / (spanMs / 1000)

  if (rate <= 0) return null
  const secondsLeft = (t.chunksTotal - t.chunksDone) / rate

  if (secondsLeft < 90) return 'almost done'
  const minutes = Math.round(secondsLeft / 60)

  if (minutes <= 10) return `about ${Math.max(minutes, 2)} min left`

  return `about ${Math.round(minutes / 5) * 5} min left`
}

// ─── Propagation following (uploads) ─────────────────────────────────────────

interface PendingPropagation {
  tagUid: number
  name: string
  driveId?: string
}

const PENDING_KEY = 'nook:pending-propagation'

function loadPending(): PendingPropagation[] {
  try {
    return JSON.parse(localStorage.getItem(PENDING_KEY) ?? '[]')
  } catch {
    return []
  }
}

function savePending(list: PendingPropagation[]) {
  localStorage.setItem(PENDING_KEY, JSON.stringify(list))
}

function clearPending(tagUid: number) {
  savePending(loadPending().filter(p => p.tagUid !== tagUid))
}

/**
 * Follow a Bee tag until the upload is on the network, feeding this store
 * (and the caller's optional pct callback). Rings the bell on completion and
 * keeps a localStorage marker so a reopened dashboard can resume following.
 * Same stall semantics as waitForTagPropagation: `complete: false` is a soft
 * outcome — Bee's background pusher keeps working.
 */
export async function followTagPropagation(
  tagUid: number,
  name: string,
  driveId: string | undefined,
  onPct?: (pct: number) => void,
): Promise<{ complete: boolean }> {
  const id = `tag:${tagUid}`
  const store = useTransfersStore.getState()

  store.begin({ id, kind: 'upload', name, driveId, phase: 'Propagating to network…' })
  savePending([...loadPending().filter(p => p.tagUid !== tagUid), { tagUid, name, driveId }])

  const { complete } = await waitForTagPropagation(tagUid, onPct, {
    onTag: tag => useTransfersStore.getState().chunkProgress(id, tag.seen + tag.synced, tag.split),
  })

  clearPending(tagUid)

  if (complete) {
    useTransfersStore.getState().finish(id)
    serverApi
      .createNotification({
        type: 'info',
        title: 'Stored on the network',
        body: `“${name}” has reached the network — every piece is confirmed stored.`,
        link: '/drive',
      })
      .catch(() => undefined)
  } else {
    useTransfersStore.getState().update(id, { phase: 'Still propagating in the background…' })
    useTransfersStore.getState().finish(id)
  }

  return { complete }
}

/**
 * Re-attach to propagations that were still running when the dashboard was
 * last closed (tags persist on the Bee node). Mounted once from Layout.
 */
export function resumePendingPropagation(): void {
  for (const p of loadPending()) {
    void followTagPropagation(p.tagUid, p.name, p.driveId)
  }
}
