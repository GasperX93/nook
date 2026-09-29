/**
 * One retry policy for every Bee upload (first publish, drive uploads, site
 * updates) — so a copy that fails while Bee shuts down or restarts waits it
 * out instead of burning its attempts.
 *
 * Bee answers "ready" for a few seconds after a stop begins while uploads to
 * it already fail (seen: ~6 s). The delay runs BEFORE the readiness check, so
 * each attempt checks Bee right before it copies; attempts that fail because
 * Bee went down are free, up to `freeRetries`, so a node that keeps dropping
 * can't retry forever.
 */

/** A full drive stays full — retrying only delays the "drive is full" message. */
export function isDriveFullError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : typeof err === 'string' ? err : ''

  return msg.toLowerCase().includes('overissued') || msg.includes('402')
}

export interface UploadRetryOptions {
  /** Attempts that count (outages excepted). */
  attempts: number
  /** Wait before each retry. */
  delayMs: number
  /** Resolves once Bee is ready; true when it had to wait (i.e. Bee was down). */
  pause: () => Promise<boolean>
  /** Called before each retry with its number (1 = first retry). */
  onRetry?: (retry: number) => void
  /** Attempts that fail because Bee was down and don't count (default 3). */
  freeRetries?: number
}

export async function withUploadRetries<T>(run: () => Promise<T>, opts: UploadRetryOptions): Promise<T> {
  let free = opts.freeRetries ?? 3

  for (let attempt = 1; ; attempt++) {
    if (attempt > 1) {
      opts.onRetry?.(attempt - 1)
      await new Promise(r => setTimeout(r, opts.delayMs))
    }

    try {
      await opts.pause()

      return await run()
    } catch (err) {
      if (isDriveFullError(err)) throw err

      // Bee went down mid-copy: wait for it and try again without using up
      // an attempt — an outage isn't a failed upload (R8-3).
      if (free > 0 && (await opts.pause())) {
        free--
        attempt--
      } else if (attempt >= opts.attempts) {
        throw err
      }
    }
  }
}
