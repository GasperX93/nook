import { existsSync, readFileSync, writeFileSync } from 'fs'

import { logger } from './logger'
import { getPath } from './path'

// Registry of postage batches managed exclusively by the reclaimable-drive
// engine (#99). These batches are stamped CLIENT-SIDE against a local slot
// ledger; any write that goes through Bee's own stamper allocates slots the
// ledger cannot see, which later causes duplicate stamps and silent data loss
// (proven in the #99 spike). Every server path that lets a caller stamp with
// an arbitrary batch must consult this registry and refuse reclaimable ones.

export interface ReclaimableBatch {
  batchId: string
  depth: number
  encrypted: boolean
  label?: string
  createdAt: string
}

// etherchunk (formerly swarm-fs) SlotMap silently corrupted its ledger below depth 19 (fractional
// bytes-per-bucket → allocations never recorded → duplicate stamps → chunk
// loss; see Cafe137/etherchunk#1, fixed in swarm-fs 1.3.2 = etherchunk 1.0.0).
export const MIN_RECLAIMABLE_DEPTH = 19

export const RECLAIMABLE_WRITE_BLOCKED_MESSAGE =
  'This drive manages its own storage. Writing to it outside the drive would corrupt its ledger and lose data.'

const REGISTRY_FILE = 'reclaimable-batches.json'

const BATCH_ID_REGEX = /^[0-9a-f]{64}$/

let cache: ReclaimableBatch[] | null = null

function registryPath(): string {
  return getPath(REGISTRY_FILE)
}

export function listReclaimableBatches(): ReclaimableBatch[] {
  if (cache) {
    return cache
  }

  if (!existsSync(registryPath())) {
    cache = []

    return cache
  }
  try {
    cache = JSON.parse(readFileSync(registryPath(), 'utf-8')) as ReclaimableBatch[]
  } catch (error) {
    // An unreadable registry means we can no longer tell which batches are
    // ledger-managed. Failing closed would block ALL Bee writes, so fail open —
    // but loudly: this state risks ledger poisoning and needs attention.
    logger.error(`reclaimable registry unreadable at ${registryPath()} — poisoning guards are OFF: ${error}`)
    cache = []
  }

  return cache
}

export function registerReclaimableBatch(entry: ReclaimableBatch): void {
  const batchId = entry.batchId.toLowerCase()

  if (!BATCH_ID_REGEX.test(batchId)) {
    throw new Error(`Invalid batch ID: ${entry.batchId}`)
  }

  if (!Number.isInteger(entry.depth) || entry.depth < MIN_RECLAIMABLE_DEPTH) {
    throw new Error(`Reclaimable drives require depth >= ${MIN_RECLAIMABLE_DEPTH}, got ${entry.depth}`)
  }
  const batches = listReclaimableBatches().filter(existing => existing.batchId !== batchId)
  batches.push({ ...entry, batchId })
  writeFileSync(registryPath(), JSON.stringify(batches, null, 2))
  cache = batches
}

export function isReclaimableBatch(batchId: string | undefined | null): boolean {
  if (!batchId) {
    return false
  }

  const normalized = batchId.toLowerCase()

  return listReclaimableBatches().some(entry => entry.batchId === normalized)
}

// Guard decision for the /bee-api pass-through proxy. Returns a rejection
// message when the request would let Bee's stamper touch a reclaimable batch,
// null when the request is fine.
//
// - Writes carrying `swarm-postage-batch-id` cover /bzz, /bytes, /chunks,
//   /soc, /feeds, /act and grantee operations — all stamp server-side.
// - Dilute changes the batch depth underneath the slot ledger, so it is
//   blocked by path. Top-up only extends TTL and stays allowed (it is how
//   "Extend storage" will work for these drives too).
export function findBlockedBeeWrite(
  method: string,
  beePath: string,
  headers: Record<string, string | string[] | undefined>,
): string | null {
  const hasWriteBody = ['POST', 'PUT', 'PATCH'].includes(method.toUpperCase())
  const batchHeader = headers['swarm-postage-batch-id']

  if (hasWriteBody && typeof batchHeader === 'string' && isReclaimableBatch(batchHeader)) {
    return RECLAIMABLE_WRITE_BLOCKED_MESSAGE
  }

  const diluteMatch = beePath.match(/^\/stamps\/dilute\/([0-9a-fA-F]{64})(\/|$)/)

  if (diluteMatch && isReclaimableBatch(diluteMatch[1])) {
    return RECLAIMABLE_WRITE_BLOCKED_MESSAGE
  }

  return null
}

// Test hook: the module-level cache would otherwise leak state across specs.
export function resetReclaimableRegistryCache(): void {
  cache = null
}
