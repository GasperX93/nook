/**
 * How much of a drive is used and how much can still be uploaded.
 *
 * Bee only reports its FULLEST bucket (`utilizationRatio`), not total fill, so
 * "used" is the larger of two numbers — the same rule as the Swarm Desktop
 * drives screen:
 *  - the file sizes Nook recorded for this drive, and
 *  - size × Bee's ratio, which also counts uploads Nook has no record of
 *    (website updates, folder index chunks, other tools).
 * The ratio alone decides "almost full" / "full": at 1 an immutable drive
 * refuses any write that lands in the full bucket.
 */

export const ALMOST_FULL_RATIO = 0.75

export type DriveSpaceState = 'ok' | 'almost-full' | 'full'

export interface DriveSpace {
  sizeBytes: number
  usedBytes: number
  leftBytes: number
  /** 0–1, for the usage bar */
  usedRatio: number
  state: DriveSpaceState
}

export function driveSpace(sizeBytes: number, fillRatio: number, recordedBytes: number): DriveSpace {
  const ratio = Math.min(Math.max(fillRatio, 0), 1)
  const state: DriveSpaceState = ratio >= 1 ? 'full' : ratio >= ALMOST_FULL_RATIO ? 'almost-full' : 'ok'
  const usedBytes = state === 'full' ? sizeBytes : Math.min(Math.max(recordedBytes, sizeBytes * ratio), sizeBytes)
  const leftBytes = Math.max(sizeBytes - usedBytes, 0)

  return {
    sizeBytes,
    usedBytes: Math.round(usedBytes),
    leftBytes: Math.round(leftBytes),
    usedRatio: sizeBytes > 0 ? usedBytes / sizeBytes : 0,
    state,
  }
}

/** Whether an upload of `bytes` fits in what's left. */
export function fitsInDrive(space: DriveSpace, bytes: number): boolean {
  return space.state !== 'full' && bytes <= space.leftBytes
}
