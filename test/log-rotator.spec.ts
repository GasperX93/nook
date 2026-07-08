import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'fs'
import { join } from 'path'

jest.mock('env-paths', () =>
  jest.fn().mockImplementation(() => ({
    data: 'test/data',
    config: 'test/data',
    cache: 'test/data',
    log: 'test/data',
    temp: 'test/data',
  })),
)

import { RotatingLogWriter } from '../src/log-rotator'

const DIR = 'test/data/log-rotator'
const BASE = join(DIR, 'bee')

function logFiles(): string[] {
  return readdirSync(DIR)
    .filter(f => /^bee\.\d+\.log$/.test(f))
    .sort()
}

async function settle(ms = 50): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

describe('RotatingLogWriter', () => {
  beforeEach(() => {
    rmSync(DIR, { recursive: true, force: true })
    mkdirSync(DIR, { recursive: true })
  })

  afterAll(() => {
    rmSync(DIR, { recursive: true, force: true })
  })

  test('writes below the cap land in the active file', async () => {
    const writer = new RotatingLogWriter(BASE, { maxBytes: 1000, maxFiles: 3 })

    writer.write('hello ')
    writer.write('world\n')
    await writer.close()

    expect(readFileSync(`${BASE}.0.log`, 'utf8')).toBe('hello world\n')
    expect(logFiles()).toEqual(['bee.0.log'])
  })

  test('exceeding the cap rotates: old content shifts to .1, fresh .0 continues', async () => {
    const writer = new RotatingLogWriter(BASE, { maxBytes: 20, maxFiles: 3 })

    writer.write('first-file-content\n') // 19 bytes — fits
    writer.write('second\n') // would exceed 20 — triggers rotation, buffered, lands in new .0
    await settle()
    await writer.close()

    expect(readFileSync(`${BASE}.1.log`, 'utf8')).toBe('first-file-content\n')
    expect(readFileSync(`${BASE}.0.log`, 'utf8')).toBe('second\n')
  })

  test('writes during rotation are buffered, never lost', async () => {
    const writer = new RotatingLogWriter(BASE, { maxBytes: 10, maxFiles: 5 })

    writer.write('0123456789') // fills the cap exactly
    // All of these arrive while the first rotation may still be in flight
    writer.write('AAAA\n')
    writer.write('BBBB\n')
    writer.write('CCCC\n')
    await settle(100)
    await writer.close()

    const all = logFiles()
      .map(f => readFileSync(join(DIR, f), 'utf8'))
      .join('')

    expect(all).toContain('AAAA')
    expect(all).toContain('BBBB')
    expect(all).toContain('CCCC')
    expect(all).toContain('0123456789')
  })

  test('never keeps more than maxFiles files', async () => {
    const writer = new RotatingLogWriter(BASE, { maxBytes: 10, maxFiles: 3 })

    for (let i = 0; i < 10; i++) {
      writer.write(`chunk-${i}-padding\n`) // each write exceeds the cap → rotates
      await settle(30)
    }
    await writer.close()

    expect(logFiles().length).toBeLessThanOrEqual(3)
  })

  test('appends to an existing .0 file and counts its size toward the cap', async () => {
    const first = new RotatingLogWriter(BASE, { maxBytes: 1000, maxFiles: 3 })

    first.write('previous run\n')
    await first.close()

    const second = new RotatingLogWriter(BASE, { maxBytes: 1000, maxFiles: 3 })

    second.write('next run\n')
    await second.close()

    expect(readFileSync(`${BASE}.0.log`, 'utf8')).toBe('previous run\nnext run\n')
  })

  test('symlink points at the active file', async () => {
    const link = join(DIR, 'bee.current.log')
    const writer = new RotatingLogWriter(BASE, { maxBytes: 1000, maxFiles: 3, symlinkPath: link })

    writer.write('linked\n')
    await writer.close()

    expect(existsSync(link)).toBe(true)
    expect(readFileSync(link, 'utf8')).toBe('linked\n')
  })

  test('close() is final — writes after close are ignored', async () => {
    const writer = new RotatingLogWriter(BASE, { maxBytes: 1000, maxFiles: 3 })

    writer.write('kept\n')
    await writer.close()
    writer.write('dropped\n')
    await settle()

    expect(readFileSync(`${BASE}.0.log`, 'utf8')).toBe('kept\n')
  })
})
