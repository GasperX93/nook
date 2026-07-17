import { Binary } from 'cafe-utility'
import Wallet from 'ethereumjs-wallet'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs'
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

// Shared job runner: uploadPath is a file OR a directory (swarm-fs builds a
// Mantaray manifest for directories, same as classic collection uploads).
function runUploadJob(entry: ReclaimableBatch, displayName: string, uploadPath: string, cleanupDir: string): UploadJob {
  const job: UploadJob = {
    id: randomUUID(),
    batchId: entry.batchId,
    fileName: displayName,
    chunksUploaded: 0,
    status: 'uploading',
  }
  jobs.set(job.id, job)
  sweepJobs()

  enqueue(entry.batchId, async () => {
    try {
      rebuildFreeBitmapIfMissing(entry.batchId, entry.depth)
      const swarmFs = await loadSwarmFs()
      const root = await swarmFs.upload({
        signer: await readSigner(),
        batchId: Binary.hexToUint8Array(entry.batchId),
        batchDepth: entry.depth,
        uploadUrl: 'http://127.0.0.1:1633/chunks',
        stateDir: reclaimableStateDir(),
        path: uploadPath,
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
      logger.error(`reclaimable upload failed (${displayName} → ${entry.batchId.slice(0, 8)}): ${error}`)
      job.status = 'error'
      job.error = String((error as Error).message ?? error)
    } finally {
      job.finishedAt = Date.now()
      rmSync(cleanupDir, { recursive: true, force: true })
    }
  })

  return job
}

export async function startUpload(batchId: string, fileName: string, data: Buffer): Promise<UploadJob> {
  const entry = requireRegisteredBatch(batchId)
  // The temp file carries the real file name (inside a throwaway dir)
  // because swarm-fs records the upload path in its registry.
  const dir = await mkdtemp(path.join(tmpdir(), 'nook-reclaimable-'))
  writeFileSync(path.join(dir, path.basename(fileName)), data)

  return runUploadJob(entry, fileName, path.join(dir, path.basename(fileName)), dir)
}

// ─── Folder upload staging ───────────────────────────────────────────────────
// The renderer can't send a directory in one request without multipart, so it
// stages files one raw-body POST at a time, then commits: the staged tree is
// handed to swarm-fs as a directory (→ Mantaray manifest, kind 'manifest').

interface UploadStage {
  id: string
  batchId: string
  dir: string
  createdAt: number
  fileCount: number
}

const stages = new Map<string, UploadStage>()

const STAGE_RETENTION_MS = 60 * 60_000

function sweepStages(): void {
  const now = Date.now()

  stages.forEach((stage, id) => {
    if (now - stage.createdAt > STAGE_RETENTION_MS) {
      rmSync(stage.dir, { recursive: true, force: true })
      stages.delete(id)
    }
  })
}

export async function createUploadStage(batchId: string): Promise<{ stageId: string }> {
  const entry = requireRegisteredBatch(batchId)
  const dir = await mkdtemp(path.join(tmpdir(), 'nook-reclaimable-stage-'))
  const stage: UploadStage = { id: randomUUID(), batchId: entry.batchId, dir, createdAt: Date.now(), fileCount: 0 }
  stages.set(stage.id, stage)
  sweepStages()

  return { stageId: stage.id }
}

export function addFileToStage(stageId: string, relPath: string, data: Buffer): { fileCount: number } {
  const stage = stages.get(stageId)

  if (!stage) {
    throw new Error('Unknown upload stage')
  }

  // The relative path comes from the renderer — reject anything that could
  // escape the staging dir.
  const normalized = path.normalize(relPath)

  if (path.isAbsolute(normalized) || normalized.split(path.sep).includes('..')) {
    throw new Error(`Invalid file path: ${relPath}`)
  }
  const dest = path.join(stage.dir, normalized)

  if (!dest.startsWith(stage.dir + path.sep)) {
    throw new Error(`Invalid file path: ${relPath}`)
  }
  mkdirSync(path.dirname(dest), { recursive: true })
  writeFileSync(dest, data)
  stage.fileCount += 1

  return { fileCount: stage.fileCount }
}

export function commitUploadStage(stageId: string, folderName: string): UploadJob {
  const stage = stages.get(stageId)

  if (!stage) {
    throw new Error('Unknown upload stage')
  }

  if (stage.fileCount === 0) {
    throw new Error('Upload stage is empty')
  }
  stages.delete(stageId)
  const entry = requireRegisteredBatch(stage.batchId)
  // swarm-fs records the directory path in its registry — give the staged
  // tree the real folder name so listings show it. If the renderer staged
  // paths already rooted in that folder, the dir exists; otherwise wrap.
  const dirName = path.basename(folderName) || 'folder'
  const namedDir = path.join(stage.dir, dirName)
  const staged = readdirSync(stage.dir)

  if (!(staged.length === 1 && staged[0] === dirName)) {
    mkdirSync(namedDir, { recursive: true })

    for (const item of staged) {
      if (item !== dirName) {
        renameSync(path.join(stage.dir, item), path.join(namedDir, item))
      }
    }
  }

  // swarm-fs only writes a website-index-document entry when index.html
  // exists, and Bee 404s a manifest root without one — a plain folder of
  // files would not be browseable at /bzz/<ref>/. Generate a minimal listing
  // so the folder link always opens. (Real websites keep their own index.)
  if (!existsSync(path.join(namedDir, 'index.html'))) {
    writeFileSync(path.join(namedDir, 'index.html'), buildFolderIndexHtml(dirName, listFilesRecursive(namedDir)))
  }

  return runUploadJob(entry, folderName, namedDir, stage.dir)
}

function listFilesRecursive(dir: string, prefix = ''): string[] {
  const results: string[] = []

  for (const item of readdirSync(dir, { withFileTypes: true })) {
    if (item.isDirectory()) {
      results.push(...listFilesRecursive(path.join(dir, item.name), `${prefix}${item.name}/`))
    } else {
      results.push(`${prefix}${item.name}`)
    }
  }

  return results.sort()
}

function buildFolderIndexHtml(folderName: string, relPaths: string[]): string {
  const escape = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  const items = relPaths.map(p => `<li><a href="${escape(encodeURI(p))}">${escape(p)}</a></li>`).join('\n      ')

  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escape(folderName)}</title>
    <style>
      body { font-family: -apple-system, system-ui, sans-serif; max-width: 640px; margin: 3rem auto; padding: 0 1rem; color: #222; }
      h1 { font-size: 1.1rem; }
      ul { list-style: none; padding: 0; }
      li { padding: 0.35rem 0; border-bottom: 1px solid #eee; }
      a { color: #0366d6; text-decoration: none; word-break: break-all; }
      a:hover { text-decoration: underline; }
      p { color: #888; font-size: 0.8rem; }
    </style>
  </head>
  <body>
    <h1>${escape(folderName)}</h1>
    <ul>
      ${items}
    </ul>
    <p>${relPaths.length} file${relPaths.length === 1 ? '' : 's'} · stored on Swarm</p>
  </body>
</html>
`
}

// ─── Organizational folders ──────────────────────────────────────────────────
// Grouping only — no Swarm objects involved. Stored server-side next to the
// ledger (classic drives keep this in localStorage, which fragments across
// origins/reinstalls; reclaimable file lists are server-backed, so their
// folder structure is too).

interface DriveFolders {
  folders: { id: string; name: string }[]
  // file reference (hex) → folder id
  assignments: Record<string, string>
}

function foldersPath(): string {
  return path.join(reclaimableStateDir(), 'folders.json')
}

function readAllFolders(): Record<string, DriveFolders> {
  if (!existsSync(foldersPath())) {
    return {}
  }
  try {
    return JSON.parse(readFileSync(foldersPath(), 'utf-8')) as Record<string, DriveFolders>
  } catch (error) {
    logger.error(`reclaimable folders file unreadable: ${error}`)

    return {}
  }
}

function writeAllFolders(all: Record<string, DriveFolders>): void {
  writeFileSync(foldersPath(), JSON.stringify(all, null, 2))
}

function driveFolders(all: Record<string, DriveFolders>, batchId: string): DriveFolders {
  return all[batchId] ?? { folders: [], assignments: {} }
}

export function createReclaimableFolder(batchId: string, name: string): { id: string; name: string } {
  const entry = requireRegisteredBatch(batchId)
  const all = readAllFolders()
  const drive = driveFolders(all, entry.batchId)
  const folder = { id: randomUUID(), name: name.trim() }

  if (!folder.name) {
    throw new Error('Folder name is required')
  }
  drive.folders.push(folder)
  all[entry.batchId] = drive
  writeAllFolders(all)

  return folder
}

export function deleteReclaimableFolder(batchId: string, folderId: string): void {
  const entry = requireRegisteredBatch(batchId)
  const all = readAllFolders()
  const drive = driveFolders(all, entry.batchId)
  drive.folders = drive.folders.filter(folder => folder.id !== folderId)

  // Files fall back to the drive root
  for (const [reference, assigned] of Object.entries(drive.assignments)) {
    if (assigned === folderId) {
      delete drive.assignments[reference]
    }
  }
  all[entry.batchId] = drive
  writeAllFolders(all)
}

export function assignFileToFolder(batchId: string, reference: string, folderId: string | null): void {
  const entry = requireRegisteredBatch(batchId)
  const all = readAllFolders()
  const drive = driveFolders(all, entry.batchId)

  if (folderId) {
    if (!drive.folders.some(folder => folder.id === folderId)) {
      throw new Error('Unknown folder')
    }
    drive.assignments[reference.toLowerCase()] = folderId
  } else {
    delete drive.assignments[reference.toLowerCase()]
  }
  all[entry.batchId] = drive
  writeAllFolders(all)
}

function removeFolderAssignment(batchId: string, reference: string): void {
  const all = readAllFolders()
  const drive = all[batchId]

  if (drive && drive.assignments[reference.toLowerCase()]) {
    delete drive.assignments[reference.toLowerCase()]
    writeAllFolders(all)
  }
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
    removeFolderAssignment(entry.batchId, rootHex)

    return swarmFs.status(opts)
  })
}

export interface ReclaimableDriveView extends ReclaimableBatch {
  folders: { id: string; name: string }[]
  files: {
    name: string
    reference: string
    kind: string
    chunkCount: number
    uploadDate?: number
    folderId?: string
  }[]
  usage: SwarmFsStats | null
}

export async function listReclaimableDrives(): Promise<ReclaimableDriveView[]> {
  const drives: ReclaimableDriveView[] = []

  const allFolders = readAllFolders()

  for (const entry of listReclaimableBatches()) {
    const { folders, assignments } = driveFolders(allFolders, entry.batchId)

    try {
      const swarmFs = await loadSwarmFs()
      const opts = {
        batchId: Binary.hexToUint8Array(entry.batchId),
        batchDepth: entry.depth,
        stateDir: reclaimableStateDir(),
      }
      drives.push({
        ...entry,
        folders,
        files: swarmFs.list(opts).map(row => {
          const reference = Binary.uint8ArrayToHex(row.rootHash)

          return {
            name: path.basename(row.path),
            reference,
            kind: row.kind,
            chunkCount: row.chunkCount,
            uploadDate: row.uploadDate,
            folderId: assignments[reference.toLowerCase()],
          }
        }),
        usage: swarmFs.status(opts),
      })
    } catch (error) {
      logger.error(`reclaimable drive listing failed for ${entry.batchId.slice(0, 8)}: ${error}`)
      drives.push({ ...entry, folders, files: [], usage: null })
    }
  }

  return drives
}
