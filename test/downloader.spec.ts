jest.mock('env-paths', () =>
  jest.fn().mockImplementation(() => ({
    data: 'test/data/downloader-spec',
    config: 'test/data/downloader-spec',
    cache: 'test/data/downloader-spec',
    log: 'test/data/downloader-spec',
    temp: 'test/data/downloader-spec',
  })),
)
jest.mock('node-fetch', () => jest.fn())

import { createHash } from 'crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import fetch from 'node-fetch'

import { BEE_SHA256, beeAssetName, runDownloader } from '../src/downloader'

// Bee is downloaded into a temp file and renamed over the old one, and only a
// real download replaces it. Writing over the binary in place left a Bee that
// macOS killed on every start; an error page was saved as `bee`.

const DIR = 'test/data/downloader-spec'
const BEE = `${DIR}/${process.platform === 'win32' ? 'bee.exe' : 'bee'}`
const mockFetch = fetch as unknown as jest.Mock
const ASSET = beeAssetName() as string
const FAKE_BEE = Buffer.alloc(11 * 1024 * 1024, 1)
const REAL_SHA256 = BEE_SHA256[ASSET]

function answer(status: number, body: Buffer) {
  mockFetch.mockResolvedValueOnce({
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Not Found',
    arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.length),
  })
}

beforeEach(() => {
  rmSync(DIR, { recursive: true, force: true })
  mkdirSync(DIR, { recursive: true })
  writeFileSync(BEE, 'old bee')
  mockFetch.mockReset()
  BEE_SHA256[ASSET] = REAL_SHA256
})
afterAll(() => {
  BEE_SHA256[ASSET] = REAL_SHA256
  rmSync(DIR, { recursive: true, force: true })
})

test('an error answer from GitHub never replaces Bee', async () => {
  answer(404, Buffer.from('Not Found'))
  await expect(runDownloader(true)).rejects.toThrow('404')
  expect(readFileSync(BEE, 'utf8')).toBe('old bee')
  expect(existsSync(`${BEE}.download`)).toBe(false)
})

test('a download too small to be Bee never replaces it', async () => {
  answer(200, Buffer.from('<html>rate limited</html>'))
  await expect(runDownloader(true)).rejects.toThrow('bytes')
  expect(readFileSync(BEE, 'utf8')).toBe('old bee')
  expect(existsSync(`${BEE}.download`)).toBe(false)
})

test('a good download replaces Bee as a new file, not in place', async () => {
  const before = statSync(BEE).ino

  BEE_SHA256[ASSET] = createHash('sha256').update(FAKE_BEE).digest('hex')
  answer(200, FAKE_BEE)
  await runDownloader(true)
  expect(statSync(BEE).size).toBe(11 * 1024 * 1024)
  expect(statSync(BEE).ino).not.toBe(before)
  expect(existsSync(`${BEE}.download`)).toBe(false)
})

test('a download that is not the pinned Bee never replaces it', async () => {
  // Big enough and a 200 — but not the file whose checksum is pinned.
  answer(200, FAKE_BEE)
  await expect(runDownloader(true)).rejects.toThrow('checksum mismatch')
  expect(readFileSync(BEE, 'utf8')).toBe('old bee')
  expect(existsSync(`${BEE}.download`)).toBe(false)
})

test('a Bee with no pinned checksum is not downloaded at all', async () => {
  BEE_SHA256[ASSET] = ''
  await expect(runDownloader(true)).rejects.toThrow('No checksum')
  expect(mockFetch).not.toHaveBeenCalled()
  expect(readFileSync(BEE, 'utf8')).toBe('old bee')
})

test('every system Nook is built for has a pinned checksum', () => {
  for (const asset of [
    'bee-darwin-arm64',
    'bee-darwin-amd64',
    'bee-linux-amd64',
    'bee-linux-arm64',
    'bee-windows-amd64.exe',
  ]) {
    expect(BEE_SHA256[asset]).toMatch(/^[0-9a-f]{64}$/)
  }
})
