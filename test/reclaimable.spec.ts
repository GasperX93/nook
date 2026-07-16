jest.mock('env-paths', () =>
  jest.fn().mockImplementation(() => ({
    data: 'test/data',
    config: 'test/data',
    cache: 'test/data',
    log: 'test/data',
    temp: 'test/data',
  })),
)

// The engine reads the node wallet key per upload; specs never exercise real
// signing, so stub the key plumbing outright.
jest.mock('ethereumjs-wallet', () => ({
  fromV3: jest.fn().mockResolvedValue({ getPrivateKeyString: () => '0x1' }),
}))
jest.mock('fs/promises', () => ({
  ...jest.requireActual('fs/promises'),
  readFile: jest.fn().mockResolvedValue('{}'),
}))
jest.mock('../src/config', () => ({
  ...jest.requireActual('../src/config'),
  readWalletPasswordOrThrow: () => 'password',
}))

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'

import {
  buildDirectFetch,
  deleteReclaimableFile,
  getUploadJob,
  listReclaimableDrives,
  rebuildFreeBitmapIfMissing,
  setSwarmFsModuleForTests,
  startUpload,
} from '../src/reclaimable'
import { registerReclaimableBatch, resetReclaimableRegistryCache } from '../src/reclaimable-registry'

const BATCH = 'c'.repeat(64)
const ROOT = 'd'.repeat(64)
const REGISTRY = 'test/data/reclaimable-batches.json'
const STATE_DIR = 'test/data/swarmfs'

function makeFakeSwarmFs(overrides: Record<string, unknown> = {}) {
  return {
    upload: jest.fn(async (opts: any): Promise<Buffer> => {
      // Real swarm-fs calls onProgress once per chunk (and resets its counter
      // per file) — the engine counts calls, so N calls → chunksUploaded = N.
      for (let i = 0; i < 42; i++) opts.onProgress?.('file', i + 1)

      return Buffer.from(ROOT, 'hex')
    }),
    deleteFile: jest.fn(async (): Promise<void> => undefined),
    list: jest.fn(() => [
      {
        path: '/tmp/nook-reclaimable-x/photo.jpg',
        rootHash: Buffer.from(ROOT, 'hex'),
        kind: 'file',
        chunkCount: 42,
        redundancyLevel: 0,
        uploadDate: 1700000000000,
      },
    ]),
    status: jest.fn(() => ({ totalSlots: 524288, occupiedSlots: 42, freeSlots: 524246, slotsPerBucket: 8 })),
    ...overrides,
  }
}

async function waitForJob(id: string) {
  for (let i = 0; i < 200; i++) {
    const job = getUploadJob(id)

    if (job && job.status !== 'uploading') {
      return job
    }
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error('upload job never finished')
}

function cleanUp() {
  rmSync(REGISTRY, { force: true })
  rmSync(STATE_DIR, { recursive: true, force: true })
  resetReclaimableRegistryCache()
  setSwarmFsModuleForTests(null)
}

describe('reclaimable engine', () => {
  beforeEach(() => {
    cleanUp()
    registerReclaimableBatch({ batchId: BATCH, depth: 19, encrypted: false, createdAt: '2026-07-16T00:00:00.000Z' })
  })
  afterAll(cleanUp)

  test('upload runs through swarm-fs and reports a done job with the root reference', async () => {
    const fake = makeFakeSwarmFs()
    setSwarmFsModuleForTests(fake as any)

    const job = startUpload(BATCH, 'photo.jpg', Buffer.from('data'))
    expect(job.status).toBe('uploading')
    const finished = await waitForJob(job.id)

    expect(finished.status).toBe('done')
    expect(finished.reference).toBe(ROOT)
    expect(finished.chunksUploaded).toBe(42)

    const opts = fake.upload.mock.calls[0][0]
    expect(opts.batchDepth).toBe(19)
    expect(opts.encrypt).toBe(false)
    expect(opts.path.endsWith('photo.jpg')).toBe(true)
    expect(opts.uploadUrl).toBe('http://127.0.0.1:1633/chunks')
  })

  test('encrypted drives upload with encrypt: true', async () => {
    cleanUp()
    registerReclaimableBatch({ batchId: BATCH, depth: 20, encrypted: true, createdAt: '2026-07-16T00:00:00.000Z' })
    const fake = makeFakeSwarmFs()
    setSwarmFsModuleForTests(fake as any)

    await waitForJob(startUpload(BATCH, 'secret.pdf', Buffer.from('data')).id)
    expect(fake.upload.mock.calls[0][0].encrypt).toBe(true)
  })

  test('upload failure surfaces on the job, not as an unhandled rejection', async () => {
    setSwarmFsModuleForTests(makeFakeSwarmFs({ upload: jest.fn().mockRejectedValue(new Error('bucket full')) }) as any)

    const job = await waitForJob(startUpload(BATCH, 'photo.jpg', Buffer.from('data')).id)
    expect(job.status).toBe('error')
    expect(job.error).toContain('bucket full')
  })

  test('unregistered batch is refused before any work starts', () => {
    expect(() => startUpload('e'.repeat(64), 'photo.jpg', Buffer.from('data'))).toThrow('not a registered')
  })

  test('mutations on the same batch are serialized', async () => {
    const order: string[] = []
    let releaseFirst: () => void = () => undefined
    const gate = new Promise<void>(resolve => {
      releaseFirst = resolve
    })
    const fake = makeFakeSwarmFs({
      upload: jest
        .fn()
        .mockImplementationOnce(async () => {
          order.push('first-start')
          await gate
          order.push('first-end')

          return Buffer.from(ROOT, 'hex')
        })
        .mockImplementationOnce(async () => {
          order.push('second-start')

          return Buffer.from(ROOT, 'hex')
        }),
    })
    setSwarmFsModuleForTests(fake as any)

    const first = startUpload(BATCH, 'a.bin', Buffer.from('a'))
    const second = startUpload(BATCH, 'b.bin', Buffer.from('b'))
    await new Promise(resolve => setTimeout(resolve, 25))
    expect(order).toEqual(['first-start'])
    releaseFirst()
    await waitForJob(first.id)
    await waitForJob(second.id)
    expect(order).toEqual(['first-start', 'first-end', 'second-start'])
  })

  test('delete returns fresh usage stats', async () => {
    const fake = makeFakeSwarmFs()
    setSwarmFsModuleForTests(fake as any)

    const usage = await deleteReclaimableFile(BATCH, ROOT)
    const deleteArgs = fake.deleteFile.mock.calls[0] as unknown as [{ rootHash: Uint8Array }]
    expect(deleteArgs[0].rootHash).toEqual(new Uint8Array(Buffer.from(ROOT, 'hex')))
    expect(usage.occupiedSlots).toBe(42)
  })

  test('listing maps ledger rows to basename + hex reference', async () => {
    setSwarmFsModuleForTests(makeFakeSwarmFs() as any)

    const drives = await listReclaimableDrives()
    expect(drives).toHaveLength(1)
    expect(drives[0].files[0]).toMatchObject({ name: 'photo.jpg', reference: ROOT, chunkCount: 42 })
    expect(drives[0].usage?.freeSlots).toBe(524246)
  })

  test('listing survives a broken ledger without dropping the drive', async () => {
    setSwarmFsModuleForTests(
      makeFakeSwarmFs({
        list: jest.fn(() => {
          throw new Error('db locked')
        }),
      }) as any,
    )

    const drives = await listReclaimableDrives()
    expect(drives).toHaveLength(1)
    expect(drives[0].files).toEqual([])
    expect(drives[0].usage).toBeNull()
  })
})

describe('rebuildFreeBitmapIfMissing', () => {
  beforeEach(cleanUp)
  afterAll(cleanUp)

  const DB_PATH = `${STATE_DIR}/swarmfs-${BATCH.slice(0, 8)}.db`
  const FREE_PATH = `${STATE_DIR}/swarmfs-${BATCH.slice(0, 8)}.free`

  function createDb(pairs: [number, number][]) {
    mkdirSync(STATE_DIR, { recursive: true })
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Database = require('better-sqlite3')
    const database = new Database(DB_PATH)
    database.exec(
      'CREATE TABLE files (id INTEGER PRIMARY KEY AUTOINCREMENT, path TEXT NOT NULL, root_hash BLOB NOT NULL, chunks BLOB NOT NULL)',
    )
    const chunks = Buffer.alloc(pairs.length * 4)
    pairs.forEach(([bucket, slot], i) => {
      chunks.writeUInt16BE(bucket, i * 4)
      chunks.writeUInt16BE(slot, i * 4 + 2)
    })
    database.prepare('INSERT INTO files (path, root_hash, chunks) VALUES (?, ?, ?)').run('/x/a.bin', Buffer.alloc(32), chunks)
    database.close()
  }

  test('reconstructs the bitmap from db pairs (swarm-fs >= 1.3.2 layout)', () => {
    createDb([
      [0, 0], // bit 0 → byte 0, mask 0x01
      [0, 7], // bit 7 → byte 0, mask 0x80
      [1, 1], // bucket 1, slot 1 at depth 19 → bit 9 → byte 1, mask 0x02
      [65535, 7], // last bit of the map
    ])
    expect(rebuildFreeBitmapIfMissing(BATCH, 19)).toBe(true)

    const bitmap = readFileSync(FREE_PATH)
    expect(bitmap.length).toBe(65536)
    expect(bitmap[0]).toBe(0x81)
    expect(bitmap[1]).toBe(0x02)
    expect(bitmap[65535]).toBe(0x80)
  })

  test('no-op when bitmap already exists or db is absent', () => {
    expect(rebuildFreeBitmapIfMissing(BATCH, 19)).toBe(false)
    createDb([[0, 0]])
    writeFileSync(FREE_PATH, Buffer.alloc(65536))
    expect(rebuildFreeBitmapIfMissing(BATCH, 19)).toBe(false)
    expect(readFileSync(FREE_PATH)[0]).toBe(0) // untouched
    expect(existsSync(FREE_PATH)).toBe(true)
  })
})

describe('buildDirectFetch', () => {
  test('adds swarm-deferred-upload: false and preserves caller headers', async () => {
    const seen: any[] = []
    const fakeFetch = (async (url: any, init: any) => {
      seen.push({ url, init })

      return { ok: true } as Response
    }) as typeof fetch

    await buildDirectFetch(fakeFetch)('http://x/chunks', {
      method: 'POST',
      headers: { 'swarm-postage-stamp': 'abc' },
    })
    expect(seen[0].init.headers).toEqual({ 'swarm-postage-stamp': 'abc', 'swarm-deferred-upload': 'false' })
    expect(seen[0].init.method).toBe('POST')
    expect(seen[0].init.signal).toBeInstanceOf(AbortSignal)
  })
})
