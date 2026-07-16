import { Binary } from 'cafe-utility'
import Wallet from 'ethereumjs-wallet'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { mkdtemp, readFile } from 'fs/promises'
import { tmpdir } from 'os'
import * as path from 'path'
import { randomUUID } from 'crypto'

import { readWalletPasswordOrThrow } from './config'
import { logger } from './logger'
import { getPath } from './path'
import { listReclaimableBatches, ReclaimableBatch } from './reclaimable-registry'

// The reclaimable-drive engine (#99): uploads through swarm-fs, which stamps
// chunks client-side and tracks the (bucket, slot) each chunk occupies, so
// deleting a file frees its slots and future uploads reuse them. Design notes
// live in spindle (reclaimable-drive-design-2026-07-15.md); the spike that
// validated all of this is swarm-fs-spike-2026-07-15.md.

// ─── swarm-fs module loading ─────────────────────────────────────────────────
// swarm-fs is ESM-only ("type": "module"). Our build targets CommonJS, where
// tsc rewrites `import()` into `require()` — which cannot load ESM. Routing
// through new Function keeps a genuine dynamic import in the emitted code.
// NOTE: never import 'swarm-fs' (dist/index.js) — that is the CLI and runs
// main() on import. The library surface is dist/commands.js.

interface SwarmFsFileRow {
  path: string
  rootHash: Uint8Array
  kind: string
  chunkCount: number
  redundancyLevel: number
  uploadDate?: number
}

interface SwarmFsStats {
  totalSlots: number
  occupiedSlots: number
  freeSlots: number
  slotsPerBucket: number
}

interface SwarmFsModule {
  upload(opts: {
    signer: bigint
    batchId: Uint8Array
    batchDepth: number
    uploadUrl: string
    stateDir: string
    path: string
    encrypt?: boolean
    parallelism?: number
    fetchFn?: typeof fetch
    onProgress?: (file: string, chunks: number) => void
  }): Promise<Uint8Array>
  deleteFile(opts: { batchId: Uint8Array; batchDepth: number; stateDir: string; rootHash: Uint8Array }): Promise<void>
  list(opts: { batchId: Uint8Array; stateDir: string }): SwarmFsFileRow[]
  status(opts: { batchId: Uint8Array; batchDepth: number; stateDir: string }): SwarmFsStats
}

const dynamicImport = new Function('specifier', 'return import(specifier)') as (s: string) => Promise<SwarmFsModule>

let swarmFsModule: Promise<SwarmFsModule> | null = null

async function loadSwarmFs(): Promise<SwarmFsModule> {
  if (!swarmFsModule) {
    swarmFsModule = dynamicImport('swarm-fs/dist/commands.js')
  }

  return swarmFsModule
}

// Test hook: jest's CJS sandbox cannot dynamic-import ESM, so specs inject a fake.
export function setSwarmFsModuleForTests(module: SwarmFsModule | null): void {
  swarmFsModule = module ? Promise.resolve(module) : null
}

// ─── State locations ─────────────────────────────────────────────────────────
// The slot ledger lives in Nook's data dir (not ~/.swarmfs) so it travels with
// app-data backups and is covered by the same durability story as everything
// else. File names must match swarm-fs's getPaths() convention.

export function reclaimableStateDir(): string {
  const dir = getPath('swarmfs')
  mkdirSync(dir, { recursive: true })

  return dir
}

function ledgerPaths(batchId: string): { free: string; db: string } {
  const prefix = path.join(reclaimableStateDir(), `swarmfs-${batchId.slice(0, 8)}`)

  return { free: `${prefix}.free`, db: `${prefix}.db` }
}

// ─── Ledger rebuild ──────────────────────────────────────────────────────────
// The SQLite db stores every file's (bucket, slot) pairs, so the .free bitmap
// is fully derivable from it. If the bitmap is missing while the db has rows,
// swarm-fs would silently start from an all-free bitmap and re-issue occupied
// slots — exactly the duplicate-stamp data loss the spike demonstrated. Rebuild
// before every mutation instead. Layout must match swarm-fs >= 1.3.2: a flat
// bitmap addressed by global bit index `bucket * slotsPerBucket + slot`,
// LSB-first within each byte.

export function rebuildFreeBitmapIfMissing(batchId: string, depth: number): boolean {
  const { free, db } = ledgerPaths(batchId)

  if (existsSync(free) || !existsSync(db)) {
    return false
  }

  logger.error(`reclaimable ledger bitmap missing for batch ${batchId.slice(0, 8)} — rebuilding from SQLite`)
  // Lazy require: better-sqlite3 is a native module and only needed on this
  // recovery path. CJS require works (it ships CommonJS).
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const Database = require('better-sqlite3')
  const database = new Database(db, { readonly: true })
  const slotsPerBucket = 1 << (depth - 16)
  const bitmap = Buffer.alloc((65536 * slotsPerBucket) / 8)

  try {
    const rows = database.prepare('SELECT chunks FROM files').all() as { chunks: Buffer }[]

    for (const row of rows) {
      for (let i = 0; i + 4 <= row.chunks.length; i += 4) {
        const bucket = row.chunks.readUInt16BE(i)
        const slot = row.chunks.readUInt16BE(i + 2)
        const bitIndex = bucket * slotsPerBucket + slot
        bitmap[bitIndex >>> 3] |= 1 << (bitIndex & 7)
      }
    }
  } finally {
    database.close()
  }
  writeFileSync(free, bitmap)

  return true
}

// ─── Direct upload ───────────────────────────────────────────────────────────
// swarm-fs alone sends deferred uploads: Bee 201s into an upload store that is
// invisible to retrieval, and "uploaded" means nothing yet (the #86 trap, re-
// confirmed in the spike). Injecting this fetchFn makes every chunk POST wait
// for a pushsync receipt — progress counts are then network-confirmed. The
// timeout is raised from swarm-fs's 30s: receipts usually land in well under a
// second, but a congested light node should soften, not fail.

export function buildDirectFetch(fetchFn: typeof fetch = fetch): typeof fetch {
  return async (url, init) =>
    fetchFn(url, {
      ...init,
      headers: { ...(init?.headers as Record<string, string>), 'swarm-deferred-upload': 'false' },
      signal: AbortSignal.timeout(120_000),
    })
}

// ─── Per-batch serialization ─────────────────────────────────────────────────
// The bitmap + SQLite pair is not safe under concurrent mutation. Every
// upload/delete for a batch runs through this queue (same pattern as the
// messaging send queue).

const batchQueues = new Map<string, Promise<unknown>>()

async function enqueue<T>(batchId: string, task: () => Promise<T>): Promise<T> {
  const tail = batchQueues.get(batchId) ?? Promise.resolve()
  const run = tail.then(task, task)
  batchQueues.set(
    batchId,
    run.catch((): undefined => undefined),
  )

  return run
}

// ─── Signer ──────────────────────────────────────────────────────────────────
// The batch owner is the Bee node wallet; swarm-fs signs stamps with the same
// key Bee itself would use. Read on demand, never cached.

async function readSigner(): Promise<bigint> {
  const v3 = await readFile(getPath(path.join('data-dir', 'keys', 'swarm.key')), 'utf-8')
  const wallet = await Wallet.fromV3(v3, readWalletPasswordOrThrow())

  return BigInt(wallet.getPrivateKeyString())
}

function requireRegisteredBatch(batchId: string): ReclaimableBatch {
  const entry = listReclaimableBatches().find(batch => batch.batchId === batchId.toLowerCase())

  if (!entry) {
    throw new Error(`Batch ${batchId} is not a registered reclaimable drive`)
  }

  return entry
}

// ─── Upload jobs ─────────────────────────────────────────────────────────────
// POST returns a job id immediately; the UI polls the job for receipt-confirmed
// chunk counts. Finished jobs are kept for pickup and swept after an hour.

export interface UploadJob {
  id: string
  batchId: string
  fileName: string
  chunksUploaded: number
  status: 'uploading' | 'done' | 'error'
  reference?: string
  error?: string
  finishedAt?: number
}

const jobs = new Map<string, UploadJob>()

const JOB_RETENTION_MS = 60 * 60_000

function sweepJobs(): void {
  const now = Date.now()

  jobs.forEach((job, id) => {
    if (job.finishedAt && now - job.finishedAt > JOB_RETENTION_MS) {
      jobs.delete(id)
    }
  })
}

export function getUploadJob(id: string): UploadJob | undefined {
  return jobs.get(id)
}

export function startUpload(batchId: string, fileName: string, data: Buffer): UploadJob {
  const entry = requireRegisteredBatch(batchId)
  const job: UploadJob = {
    id: randomUUID(),
    batchId: entry.batchId,
    fileName,
    chunksUploaded: 0,
    status: 'uploading',
  }
  jobs.set(job.id, job)
  sweepJobs()

  enqueue(entry.batchId, async () => {
    // The temp file carries the real file name (inside a throwaway dir)
    // because swarm-fs records the upload path in its registry.
    const dir = await mkdtemp(path.join(tmpdir(), 'nook-reclaimable-'))
    const filePath = path.join(dir, path.basename(fileName))

    try {
      writeFileSync(filePath, data)
      rebuildFreeBitmapIfMissing(entry.batchId, entry.depth)
      const swarmFs = await loadSwarmFs()
      const root = await swarmFs.upload({
        signer: await readSigner(),
        batchId: Binary.hexToUint8Array(entry.batchId),
        batchDepth: entry.depth,
        uploadUrl: 'http://127.0.0.1:1633/chunks',
        stateDir: reclaimableStateDir(),
        path: filePath,
        encrypt: entry.encrypted,
        parallelism: 32,
        fetchFn: buildDirectFetch(),
        // Count calls ourselves: swarm-fs's per-file counter resets for the
        // manifest phase, so the passed value ends at ~3 instead of the total.
        onProgress: () => {
          job.chunksUploaded += 1
        },
      })
      job.reference = Binary.uint8ArrayToHex(root)
      job.status = 'done'
    } catch (error) {
      logger.error(`reclaimable upload failed (${fileName} → ${entry.batchId.slice(0, 8)}): ${error}`)
      job.status = 'error'
      job.error = String((error as Error).message ?? error)
    } finally {
      job.finishedAt = Date.now()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  return job
}

// ─── Delete & listing ────────────────────────────────────────────────────────

export async function deleteReclaimableFile(batchId: string, rootHex: string): Promise<SwarmFsStats> {
  const entry = requireRegisteredBatch(batchId)

  return enqueue(entry.batchId, async () => {
    rebuildFreeBitmapIfMissing(entry.batchId, entry.depth)
    const swarmFs = await loadSwarmFs()
    const opts = {
      batchId: Binary.hexToUint8Array(entry.batchId),
      batchDepth: entry.depth,
      stateDir: reclaimableStateDir(),
    }
    await swarmFs.deleteFile({ ...opts, rootHash: Binary.hexToUint8Array(rootHex) })

    return swarmFs.status(opts)
  })
}

export interface ReclaimableDriveView extends ReclaimableBatch {
  files: {
    name: string
    reference: string
    kind: string
    chunkCount: number
    uploadDate?: number
  }[]
  usage: SwarmFsStats | null
}

export async function listReclaimableDrives(): Promise<ReclaimableDriveView[]> {
  const drives: ReclaimableDriveView[] = []

  for (const entry of listReclaimableBatches()) {
    try {
      const swarmFs = await loadSwarmFs()
      const opts = {
        batchId: Binary.hexToUint8Array(entry.batchId),
        batchDepth: entry.depth,
        stateDir: reclaimableStateDir(),
      }
      drives.push({
        ...entry,
        files: swarmFs.list(opts).map(row => ({
          name: path.basename(row.path),
          reference: Binary.uint8ArrayToHex(row.rootHash),
          kind: row.kind,
          chunkCount: row.chunkCount,
          uploadDate: row.uploadDate,
        })),
        usage: swarmFs.status(opts),
      })
    } catch (error) {
      logger.error(`reclaimable drive listing failed for ${entry.batchId.slice(0, 8)}: ${error}`)
      drives.push({ ...entry, files: [], usage: null })
    }
  }

  return drives
}
