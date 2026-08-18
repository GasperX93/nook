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
  addFileToStage,
  assignFileToFolder,
  buildDirectFetch,
  commitUploadStage,
  createReclaimableFolder,
  createUploadStage,
  deleteReclaimableFile,
  deleteReclaimableFolder,
  getUploadJob,
  listReclaimableDrives,
  rebuildFreeBitmapIfMissing,
  setEtherchunkModuleForTests,
  startUpload,
} from '../src/reclaimable'
import { registerReclaimableBatch, resetReclaimableRegistryCache } from '../src/reclaimable-registry'

const BATCH = 'c'.repeat(64)
const ROOT = 'd'.repeat(64)
const REGISTRY = 'test/data/reclaimable-batches.json'
const STATE_DIR = 'test/data/etherchunk'

function makeFakeEtherchunk(overrides: Record<string, unknown> = {}) {
  return {
    upload: jest.fn(async (opts: any): Promise<Buffer> => {
      // Real etherchunk calls onProgress once per chunk (and resets its counter
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
  setEtherchunkModuleForTests(null)
}

describe('reclaimable engine', () => {
  beforeEach(() => {
    cleanUp()
    registerReclaimableBatch({ batchId: BATCH, depth: 19, encrypted: false, createdAt: '2026-07-16T00:00:00.000Z' })
  })
  afterAll(cleanUp)

  test('upload runs through etherchunk and reports a done job with the root reference', async () => {
    const fake = makeFakeEtherchunk()
    setEtherchunkModuleForTests(fake as any)

    const job = await startUpload(BATCH, 'photo.jpg', Buffer.from('data'))
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
    const fake = makeFakeEtherchunk()
    setEtherchunkModuleForTests(fake as any)

    await waitForJob((await startUpload(BATCH, 'secret.pdf', Buffer.from('data'))).id)
    expect(fake.upload.mock.calls[0][0].encrypt).toBe(true)
  })

  test('upload failure surfaces on the job, not as an unhandled rejection', async () => {
    setEtherchunkModuleForTests(makeFakeEtherchunk({ upload: jest.fn().mockRejectedValue(new Error('bucket full')) }) as any)

    const job = await waitForJob((await startUpload(BATCH, 'photo.jpg', Buffer.from('data'))).id)
    expect(job.status).toBe('error')
    expect(job.error).toContain('bucket full')
  })

  test('unregistered batch is refused before any work starts', async () => {
    await expect(startUpload('e'.repeat(64), 'photo.jpg', Buffer.from('data'))).rejects.toThrow('not a registered')
  })

  test('mutations on the same batch are serialized', async () => {
    const order: string[] = []
    let releaseFirst: () => void = () => undefined
    const gate = new Promise<void>(resolve => {
      releaseFirst = resolve
    })
    const fake = makeFakeEtherchunk({
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
    setEtherchunkModuleForTests(fake as any)

    const first = await startUpload(BATCH, 'a.bin', Buffer.from('a'))
    const second = await startUpload(BATCH, 'b.bin', Buffer.from('b'))
    await new Promise(resolve => setTimeout(resolve, 25))
    expect(order).toEqual(['first-start'])
    releaseFirst()
    await waitForJob(first.id)
    await waitForJob(second.id)
    expect(order).toEqual(['first-start', 'first-end', 'second-start'])
  })

  test('delete returns fresh usage stats', async () => {
    const fake = makeFakeEtherchunk()
    setEtherchunkModuleForTests(fake as any)

    const usage = await deleteReclaimableFile(BATCH, ROOT)
    const deleteArgs = fake.deleteFile.mock.calls[0] as unknown as [{ rootHash: Uint8Array }]
    expect(deleteArgs[0].rootHash).toEqual(new Uint8Array(Buffer.from(ROOT, 'hex')))
    expect(usage.occupiedSlots).toBe(42)
  })

  test('listing maps ledger rows to basename + hex reference', async () => {
    setEtherchunkModuleForTests(makeFakeEtherchunk() as any)

    const drives = await listReclaimableDrives()
    expect(drives).toHaveLength(1)
    expect(drives[0].files[0]).toMatchObject({ name: 'photo.jpg', reference: ROOT, chunkCount: 42 })
    expect(drives[0].usage?.freeSlots).toBe(524246)
  })

  test('listing survives a broken ledger without dropping the drive', async () => {
    setEtherchunkModuleForTests(
      makeFakeEtherchunk({
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

describe('organizational folders', () => {
  beforeEach(() => {
    cleanUp()
    registerReclaimableBatch({ batchId: BATCH, depth: 19, encrypted: false, createdAt: '2026-07-16T00:00:00.000Z' })
  })
  afterAll(cleanUp)

  test('create → assign → listing carries folders and folderId', async () => {
    setEtherchunkModuleForTests(makeFakeEtherchunk() as any)
    const folder = createReclaimableFolder(BATCH, 'Photos')
    assignFileToFolder(BATCH, ROOT, folder.id)

    const [drive] = await listReclaimableDrives()
    expect(drive.folders).toEqual([{ id: folder.id, name: 'Photos' }])
    expect(drive.files[0].folderId).toBe(folder.id)
  })

  test('assigning to an unknown folder is refused', () => {
    expect(() => assignFileToFolder(BATCH, ROOT, 'nope')).toThrow('Unknown folder')
  })

  test('deleting a folder returns its files to the drive root', async () => {
    setEtherchunkModuleForTests(makeFakeEtherchunk() as any)
    const folder = createReclaimableFolder(BATCH, 'Photos')
    assignFileToFolder(BATCH, ROOT, folder.id)
    deleteReclaimableFolder(BATCH, folder.id)

    const [drive] = await listReclaimableDrives()
    expect(drive.folders).toEqual([])
    expect(drive.files[0].folderId).toBeUndefined()
  })

  test('deleting a file cleans up its folder assignment', async () => {
    setEtherchunkModuleForTests(makeFakeEtherchunk() as any)
    const folder = createReclaimableFolder(BATCH, 'Photos')
    assignFileToFolder(BATCH, ROOT, folder.id)
    await deleteReclaimableFile(BATCH, ROOT)

    const stored = JSON.parse(readFileSync('test/data/etherchunk/folders.json', 'utf-8'))
    expect(stored[BATCH].assignments).toEqual({})
  })

  test('empty folder names are refused', () => {
    expect(() => createReclaimableFolder(BATCH, '   ')).toThrow('name is required')
  })
})

describe('folder upload staging', () => {
  beforeEach(() => {
    cleanUp()
    registerReclaimableBatch({ batchId: BATCH, depth: 19, encrypted: false, createdAt: '2026-07-16T00:00:00.000Z' })
  })
  afterAll(cleanUp)

  test('stage → add files → commit uploads the staged directory', async () => {
    const fake = makeFakeEtherchunk()
    setEtherchunkModuleForTests(fake as any)

    const { stageId } = await createUploadStage(BATCH)
    expect(addFileToStage(stageId, 'site/index.html', Buffer.from('<html/>'))).toEqual({ fileCount: 1 })
    expect(addFileToStage(stageId, 'site/img/logo.png', Buffer.from('png'))).toEqual({ fileCount: 2 })

    const job = commitUploadStage(stageId, 'site')
    const finished = await waitForJob(job.id)
    expect(finished.status).toBe('done')

    const opts = fake.upload.mock.calls[0][0]
    expect(opts.path.endsWith('/site')).toBe(true)
  })

  test('commit generates a browseable index.html when the folder has none', async () => {
    let uploaded: { files: string[]; indexContent: string } | null = null
    const fake = makeFakeEtherchunk({
      upload: jest.fn(async (opts: any): Promise<Buffer> => {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { readdirSync: rd, readFileSync: rf } = require('fs')
        uploaded = { files: rd(opts.path).sort(), indexContent: rf(`${opts.path}/index.html`, 'utf-8') }

        return Buffer.from(ROOT, 'hex')
      }),
    })
    setEtherchunkModuleForTests(fake as any)

    const { stageId } = await createUploadStage(BATCH)
    addFileToStage(stageId, 'charts/a chart.png', Buffer.from('png'))
    addFileToStage(stageId, 'charts/sub/b.svg', Buffer.from('svg'))
    await waitForJob(commitUploadStage(stageId, 'charts').id)

    expect(uploaded!.files).toEqual(['a chart.png', 'index.html', 'sub'])
    expect(uploaded!.indexContent).toContain('a%20chart.png')
    expect(uploaded!.indexContent).toContain('sub/b.svg')
    expect(uploaded!.indexContent).not.toContain('index.html</a>') // never lists itself
  })

  test('commit keeps an existing index.html untouched (websites)', async () => {
    let indexContent = ''
    const fake = makeFakeEtherchunk({
      upload: jest.fn(async (opts: any): Promise<Buffer> => {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        indexContent = require('fs').readFileSync(`${opts.path}/index.html`, 'utf-8')

        return Buffer.from(ROOT, 'hex')
      }),
    })
    setEtherchunkModuleForTests(fake as any)

    const { stageId } = await createUploadStage(BATCH)
    addFileToStage(stageId, 'site/index.html', Buffer.from('<html>mine</html>'))
    await waitForJob(commitUploadStage(stageId, 'site').id)
    expect(indexContent).toBe('<html>mine</html>')
  })

  test('path traversal is rejected', async () => {
    const { stageId } = await createUploadStage(BATCH)
    expect(() => addFileToStage(stageId, '../escape.txt', Buffer.from('x'))).toThrow('Invalid file path')
    expect(() => addFileToStage(stageId, '/etc/passwd', Buffer.from('x'))).toThrow('Invalid file path')
    expect(() => addFileToStage(stageId, 'ok/../../escape.txt', Buffer.from('x'))).toThrow('Invalid file path')
  })

  test('empty or unknown stages are refused', async () => {
    const { stageId } = await createUploadStage(BATCH)
    expect(() => commitUploadStage(stageId, 'site')).toThrow('empty')
    expect(() => addFileToStage('nope', 'a.txt', Buffer.from('x'))).toThrow('Unknown upload stage')
    expect(() => commitUploadStage('nope', 'site')).toThrow('Unknown upload stage')
  })

  test('stage refuses unregistered batches', async () => {
    await expect(createUploadStage('f'.repeat(64))).rejects.toThrow('not a registered')
  })
})

describe('swarm-fs → etherchunk state migration', () => {
  beforeEach(() => {
    cleanUp()
    rmSync('test/data/swarmfs', { recursive: true, force: true })
    registerReclaimableBatch({ batchId: BATCH, depth: 19, encrypted: false, createdAt: '2026-07-16T00:00:00.000Z' })
  })
  afterAll(() => {
    cleanUp()
    rmSync('test/data/swarmfs', { recursive: true, force: true })
  })

  test('legacy dir and ledger file prefixes are renamed forward', async () => {
    // Simulate pre-rename state: old dir name, old file prefixes
    mkdirSync('test/data/swarmfs', { recursive: true })
    writeFileSync(`test/data/swarmfs/swarmfs-${BATCH.slice(0, 8)}.free`, Buffer.alloc(65536))
    writeFileSync(`test/data/swarmfs/swarmfs-${BATCH.slice(0, 8)}.db`, Buffer.from('db'))
    writeFileSync('test/data/swarmfs/folders.json', '{}')

    setEtherchunkModuleForTests(makeFakeEtherchunk() as any)
    await listReclaimableDrives() // any state access triggers the migration

    expect(existsSync('test/data/swarmfs')).toBe(false)
    expect(existsSync(`test/data/etherchunk/etherchunk-${BATCH.slice(0, 8)}.free`)).toBe(true)
    expect(existsSync(`test/data/etherchunk/etherchunk-${BATCH.slice(0, 8)}.db`)).toBe(true)
    expect(existsSync('test/data/etherchunk/folders.json')).toBe(true)
  })
})

describe('rebuildFreeBitmapIfMissing', () => {
  beforeEach(cleanUp)
  afterAll(cleanUp)

  const DB_PATH = `${STATE_DIR}/etherchunk-${BATCH.slice(0, 8)}.db`
  const FREE_PATH = `${STATE_DIR}/etherchunk-${BATCH.slice(0, 8)}.free`

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

  test('reconstructs the bitmap from db pairs (etherchunk sub-byte layout)', () => {
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
