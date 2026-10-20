/**
 * How much of a drive is used and how much can still be uploaded.
 *
 * "Used" is what the drive really stores: Bee's bucket counts added up
 * (server /drive-usage), old website versions and folder indexes included.
 * Until that's known it falls back to the larger of the file sizes Nook
 * recorded and size × Bee's ratio. That ratio is only the FULLEST bucket, so
 * as "used" it overstated a lot (568.8 MB shown for 159.6 MB stored) — it
 * still decides "almost full" / "full": at 1 an immutable drive refuses any
 * write that lands in the full bucket.
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

export function driveSpace(
  sizeBytes: number,
  fillRatio: number,
  recordedBytes: number,
  storedBytes?: number,
): DriveSpace {
  const ratio = Math.min(Math.max(fillRatio, 0), 1)
  const state: DriveSpaceState = ratio >= 1 ? 'full' : ratio >= ALMOST_FULL_RATIO ? 'almost-full' : 'ok'
  const estimate = storedBytes ?? Math.max(recordedBytes, sizeBytes * ratio)
  const usedBytes = state === 'full' ? sizeBytes : Math.min(estimate, sizeBytes)
  const leftBytes = Math.max(sizeBytes - usedBytes, 0)

  return {
    sizeBytes,
    usedBytes: Math.round(usedBytes),
    leftBytes: Math.round(leftBytes),
    usedRatio: sizeBytes > 0 ? usedBytes / sizeBytes : 0,
    state,
  }
}

/**
 * Room kept free when checking an upload: folder index and manifest chunks
 * (and ACT metadata on encrypted drives) are stamped too, and aren't part of
 * the file sizes.
 */
export const UPLOAD_MARGIN = 0.02

/** Whether an upload of `bytes` fits in what's left. */
export function fitsInDrive(space: DriveSpace, bytes: number): boolean {
  return space.state !== 'full' && bytes <= space.leftBytes - space.sizeBytes * UPLOAD_MARGIN
}
