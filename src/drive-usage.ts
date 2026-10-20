import { readConfigYaml } from './config'
import { fetchWithTimeout } from './fetch-timeout'

/**
 * How much each drive really holds (test3 feedback 2026-10-20). Bee's
 * `/stamps` only reports the FULLEST bucket, and size × that ratio overstated
 * use badly (community-metrics: 568.8 MB shown, 159.6 MB stored). The bucket
 * list (`/stamps/{id}/buckets`) has every bucket's count; their sum is the
 * number of chunks stamped, old website versions and folder indexes included.
 * The list is ~2 MB per drive, so it's read here, summed, and cached.
 */

const CHUNK_BYTES = 4096
const CACHE_MS = 2 * 60_000

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

interface CacheEntry {
  bytes: number
  depth: number
  at: number
}

const cache = new Map<string, CacheEntry>()

export function resetDriveUsageForTests(): void {
  cache.clear()
}

/** Stored bytes per batch id (lower case). Drives Bee can't list right now are left out. */
export async function getDriveUsage(
  beeFetch: BeeFetch = realBeeFetch,
  now = Date.now(),
): Promise<Record<string, number>> {
  const res = await beeFetch('/stamps')

  if (!res.ok) return {}
  const { stamps } = (await res.json()) as { stamps?: { batchID: string; depth: number; usable: boolean }[] }
  const usage: Record<string, number> = {}

  for (const stamp of stamps ?? []) {
    if (!stamp.usable) continue
    const id = stamp.batchID.toLowerCase()
    const cached = cache.get(id)

    if (cached && cached.depth === stamp.depth && now - cached.at < CACHE_MS) {
      usage[id] = cached.bytes
      continue
    }

    try {
      const bucketsRes = await beeFetch(`/stamps/${id}/buckets`)

      if (!bucketsRes.ok) continue
      const { buckets } = (await bucketsRes.json()) as { buckets?: { collisions: number }[] }
      const bytes = (buckets ?? []).reduce((sum, b) => sum + b.collisions, 0) * CHUNK_BYTES

      cache.set(id, { bytes, depth: stamp.depth, at: now })
      usage[id] = bytes
    } catch {
      // Bee busy or restarting — this drive falls back to the old estimate.
    }
  }

  return usage
}
