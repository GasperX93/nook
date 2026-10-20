/**
 * A drive size change that's sent but not yet visible: Bee keeps showing the
 * old size until the chain confirms the change, a minute or two after the
 * Extend window closes (test3 feedback 2026-10-20). The drive card shows
 * "Extending to …" for that gap instead of the old size. In memory only — a
 * reload just shows Bee's size again.
 */
import { create } from 'zustand'

/** After this long the note goes away even if Bee never showed the new size. */
const GIVE_UP_MS = 15 * 60_000

export interface ResizeEntry {
  depth: number
  at: number
}

interface DriveResizeState {
  growing: Record<string, ResizeEntry>
  start: (batchId: string, depth: number) => void
}

export const useDriveResize = create<DriveResizeState>(set => ({
  growing: {},
  start: (batchId, depth) =>
    set(state => ({ growing: { ...state.growing, [batchId.toLowerCase()]: { depth, at: Date.now() } } })),
}))

/** The depth the drive is growing to, or null once Bee shows it (or it's been too long). */
export function growingTo(entry: ResizeEntry | undefined, currentDepth: number, now = Date.now()): number | null {
  if (!entry || currentDepth >= entry.depth || now - entry.at > GIVE_UP_MS) return null

  return entry.depth
}
