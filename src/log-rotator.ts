import { WriteStream, createWriteStream, existsSync, renameSync, statSync, symlinkSync, unlinkSync } from 'fs'
import { dirname, relative } from 'path'

import { logger } from './logger'

/**
 * Minimal size-based log rotator (replaces file-stream-rotator, see #80).
 *
 * Layout: `<base>.0.log` is always the file being written; on rotation files
 * shift `N → N+1` and the oldest (`maxFiles - 1`) is deleted. An optional
 * symlink always points at `<base>.0.log`, so it never needs re-pointing.
 *
 * Why not file-stream-rotator: its internal stream swap races in-flight writes
 * (ERR_STREAM_DESTROYED), its audit-file state corrupts across unclean exits
 * (we observed a 11.5 MB file against a 500 KB cap and numbering past
 * max_logs), and a poisoned fs error can take the whole process's file serving
 * down. This implementation makes rotation safe by construction: writes that
 * arrive while the old stream is draining are buffered in memory and flushed
 * to the fresh file once the shift completes — nothing ever writes to a
 * destroyed stream, and files are only renamed after they are closed (which
 * also makes rotation work on Windows, where open files cannot be renamed).
 */

interface RotatorOptions {
  /** Rotate when the current file would exceed this size. */
  maxBytes?: number
  /** Keep at most this many files (including the active one). */
  maxFiles?: number
  /** Optional symlink kept pointing at the active file. */
  symlinkPath?: string
}

/** Cap for the in-memory buffer used during rotation — beyond it, chunks are dropped. */
const MAX_PENDING_BYTES = 5_000_000

export class RotatingLogWriter {
  private stream: WriteStream | null = null
  private bytes = 0
  private rotating = false
  private pending: Buffer[] = []
  private pendingBytes = 0
  private closed = false

  private readonly maxBytes: number
  private readonly maxFiles: number
  private readonly symlinkPath?: string

  constructor(
    /** Path prefix — files are created as `<base>.<n>.log`. */
    private readonly base: string,
    options: RotatorOptions = {},
  ) {
    this.maxBytes = options.maxBytes ?? 500_000
    this.maxFiles = options.maxFiles ?? 10
    this.symlinkPath = options.symlinkPath
    this.open()
  }

  private filePath(index: number): string {
    return `${this.base}.${index}.log`
  }

  private open(): void {
    const current = this.filePath(0)
    this.bytes = existsSync(current) ? statSync(current).size : 0
    this.stream = createWriteStream(current, { flags: 'a' })
    // A write error must never throw into the pipe source — log and carry on;
    // the next rotation gets a fresh stream.
    this.stream.on('error', err => logger.error(`bee log write failed: ${err.message}`))
    this.ensureSymlink(current)
  }

  private ensureSymlink(target: string): void {
    if (!this.symlinkPath) return
    try {
      // Relative target (usually just the filename) — the symlink stays valid
      // regardless of the process's working directory.
      const relTarget = relative(dirname(this.symlinkPath), target)

      if (existsSync(this.symlinkPath)) unlinkSync(this.symlinkPath)
      symlinkSync(relTarget, this.symlinkPath)
    } catch {
      // Symlinks may be unavailable (e.g. unprivileged Windows) — readers fall
      // back to reading `<base>.0.log` directly, so this is cosmetic.
    }
  }

  write(chunk: Buffer | string): void {
    if (this.closed) return
    const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk

    if (this.rotating) {
      // Rotation in flight — buffer until the fresh file is open.
      if (this.pendingBytes + buf.length <= MAX_PENDING_BYTES) {
        this.pending.push(buf)
        this.pendingBytes += buf.length
      }

      return
    }

    if (!this.stream || this.stream.destroyed) return

    if (this.bytes + buf.length > this.maxBytes) {
      this.rotate(buf)

      return
    }
    this.bytes += buf.length
    this.stream.write(buf)
  }

  private rotate(firstPending: Buffer): void {
    const old = this.stream
    this.rotating = true
    this.stream = null
    this.pending = [firstPending]
    this.pendingBytes = firstPending.length

    let finished = false
    const shiftAndReopen = () => {
      if (finished) return
      finished = true

      // Closed while the rotation was in flight — do not resurrect the writer.
      if (this.closed) {
        this.rotating = false
        this.pending = []
        this.pendingBytes = 0

        return
      }

      try {
        // Oldest falls off; everything else shifts up by one.
        for (let i = this.maxFiles - 1; i >= 0; i--) {
          const from = this.filePath(i)

          if (!existsSync(from)) continue

          if (i === this.maxFiles - 1) {
            unlinkSync(from)
          } else {
            renameSync(from, this.filePath(i + 1))
          }
        }
      } catch (err) {
        logger.error(`bee log rotation failed: ${err instanceof Error ? err.message : err}`)
      }

      this.open()
      this.rotating = false
      const queued = this.pending
      this.pending = []
      this.pendingBytes = 0

      for (const buf of queued) this.write(buf)
    }

    if (!old || old.destroyed) {
      shiftAndReopen()

      return
    }
    // Only rename after the old stream is fully closed — no write can race the
    // teardown, and closed files can be renamed on every platform.
    old.once('close', shiftAndReopen)
    old.once('error', shiftAndReopen)
    old.end()
  }

  /** Flush and close. Returns once the active stream has fully closed. */
  async close(): Promise<void> {
    this.closed = true
    const stream = this.stream
    this.stream = null

    if (!stream || stream.destroyed) return

    await new Promise<void>(resolve => {
      stream.once('close', () => resolve())
      stream.once('error', () => resolve())
      stream.end()
    })
  }
}
