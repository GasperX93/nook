import { readConfigYaml } from './config'
import { fetchWithTimeout } from './fetch-timeout'
import { isOwnBee } from './foreign-bee'
import { logger } from './logger'

/**
 * Keeps a bigger drive size across restarts (test2 finding 2026-10-19).
 *
 * Bee 2.8.3 applies a size change (dilute) to its stamp issuer in memory only
 * (`HandleDepthIncrease` never marks the issuer dirty), and issuers are saved
 * only when dirty — so with no upload between the change and a restart, Bee
 * loads the old size from disk for good while the chain keeps the new one.
 * Renaming a drive (`PATCH /stamps/{id}`) saves the whole issuer at once, the
 * in-memory depth included. So: when `/stamps` shows a drive at a larger
 * depth than last seen, re-save its own label.
 *
 * Window left open: Nook quitting between Bee picking up the change and the
 * next tick (≤ 1 min). Drives already stuck can't be helped here — Bee no
 * longer holds the new size anywhere; the Extend drive window handles those.
 */

const CHECK_INTERVAL_MS = 60_000
const INITIAL_DELAY_MS = 60_000

export type BeeFetch = (path: string, init?: RequestInit, timeoutMs?: number) => Promise<Response>

function getAuthHeaders(): Record<string, string> {
  const password = readConfigYaml().password as string | undefined

  return password ? { Authorization: `Bearer ${password}` } : {}
}

const realBeeFetch: BeeFetch = async (path, init, timeoutMs = 15_000) =>
  fetchWithTimeout(
    `http://127.0.0.1:1633${path}`,
    { ...init, headers: { ...getAuthHeaders(), ...init?.headers } },
    timeoutMs,
  )

interface StampRow {
  batchID: string
  depth: number
  label?: string
}

/** Depth last seen per batch. The first sighting is what Bee loaded from disk. */
const seen = new Map<string, number>()

export function resetDepthSaveForTests(): void {
  seen.clear()
}

/** One pass. Returns the batches whose new size was saved. */
export async function runDepthSave(beeFetch: BeeFetch = realBeeFetch): Promise<string[]> {
  const res = await beeFetch('/stamps')

  if (!res.ok) return []
  const { stamps } = (await res.json()) as { stamps?: StampRow[] }
  const saved: string[] = []

  for (const stamp of stamps ?? []) {
    const id = stamp.batchID.toLowerCase()
    const prev = seen.get(id)

    // First sighting, or smaller (Bee restarted and loaded its disk copy —
    // saving that would only save the old size): just remember it.
    if (prev === undefined || stamp.depth <= prev) {
      seen.set(id, stamp.depth)
      continue
    }

    // Bee refuses an empty label; an unnamed drive can't be saved this way.
    if (!stamp.label?.trim()) {
      logger.info(`depth-save: ${id.slice(0, 8)} is now depth ${stamp.depth} but has no name — can't save it`)
      seen.set(id, stamp.depth)
      continue
    }

    if (!(await isOwnBee())) return saved

    const patch = await beeFetch(`/stamps/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: stamp.label }),
    })

    if (!patch.ok) {
      // Keep the old depth so the next tick tries again.
      logger.error(`depth-save: saving ${id.slice(0, 8)} at depth ${stamp.depth} failed (${patch.status})`)
      continue
    }
    seen.set(id, stamp.depth)
    saved.push(id)
    logger.info(`depth-save: saved ${id.slice(0, 8)} at depth ${stamp.depth} (was ${prev})`)
  }

  return saved
}

let timer: ReturnType<typeof setTimeout> | null = null

export function startDepthSave(): void {
  const schedule = (delayMs: number) => {
    timer = setTimeout(async () => {
      try {
        await runDepthSave()
      } catch (error) {
        // Bee down or restarting — the next tick tries again.
        logger.debug(`depth-save: check failed: ${(error as Error).message}`)
      }
      schedule(CHECK_INTERVAL_MS)
    }, delayMs)
  }

  schedule(INITIAL_DELAY_MS)
}

export function stopDepthSave(): void {
  if (timer) clearTimeout(timer)
  timer = null
}
