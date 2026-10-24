jest.mock('env-paths', () =>
  jest.fn().mockImplementation(() => ({
    data: 'test/data/update-checker-spec',
    config: 'test/data/update-checker-spec',
    cache: 'test/data/update-checker-spec',
    log: 'test/data/update-checker-spec',
    temp: 'test/data/update-checker-spec',
  })),
)
jest.mock('../src/notify', () => ({ createNotification: jest.fn() }))
jest.mock('../src/notifications', () => ({ pushNotification: jest.fn() }))
jest.mock('../src/fetch-timeout', () => ({ fetchWithTimeout: jest.fn() }))

import { EventEmitter } from 'events'
import { rmSync } from 'fs'

import PACKAGE_JSON from '../package.json'
import { fetchWithTimeout } from '../src/fetch-timeout'

import {
  type AutoUpdaterLike,
  getUpdateInfo,
  installUpdate,
  resetUpdaterForTests,
  startUpdateChecker,
  watchAutoUpdater,
} from '../src/update-checker'

// The Update button: restart into a downloaded version, wait for one still
// downloading, and fall back to the download link when the updater failed.

function makeUpdater() {
  const emitter = new EventEmitter()
  const installs: number[] = []
  const updater: AutoUpdaterLike = {
    on: (event, listener) => emitter.on(event, listener),
    quitAndInstall: () => installs.push(Date.now()),
  }
  const beeStops: number[] = []
  const stopBee = async () => {
    beeStops.push(1)
  }

  return { emitter, updater, installs, beeStops, stopBee }
}

const mockFetch = fetchWithTimeout as unknown as jest.Mock

// GitHub's latest release, as the label check sees it.
function githubLatest(version: string) {
  mockFetch.mockResolvedValue({
    ok: true,
    json: async () => ({ tag_name: `v${version}`, html_url: `https://x/v${version}` }),
  })
}

function bump(version: string): string {
  const [a, b, c] = version.split('.').map(Number)

  return `${a}.${b}.${c + 1}`
}

const settle = async () => new Promise(resolve => setImmediate(resolve))

beforeEach(() => {
  resetUpdaterForTests()
  mockFetch.mockReset()
  githubLatest(PACKAGE_JSON.version)
})
afterAll(() => rmSync('test/data/update-checker-spec', { recursive: true, force: true }))

test('without the updater (Linux, dev): nothing to install, download link only', async () => {
  expect(getUpdateInfo().updater).toBe('unsupported')
  expect(await installUpdate()).toBe('unavailable')
})

test('downloaded: Update stops Bee, then restarts into the new version', async () => {
  const u = makeUpdater()

  watchAutoUpdater(u.updater, u.stopBee)
  u.emitter.emit('update-available')
  expect(getUpdateInfo().updater).toBe('downloading')
  expect(getUpdateInfo().updateAvailable).toBe(true)
  u.emitter.emit('update-downloaded')
  expect(getUpdateInfo().updater).toBe('ready')
  expect(await installUpdate()).toBe('installing')
  expect(u.beeStops).toHaveLength(1)
  expect(u.installs).toHaveLength(1)
})

test('still downloading: Update waits and restarts once the download is done', async () => {
  const u = makeUpdater()

  watchAutoUpdater(u.updater, u.stopBee)
  u.emitter.emit('update-available')
  expect(await installUpdate()).toBe('waiting')
  expect(getUpdateInfo().installRequested).toBe(true)
  expect(u.installs).toHaveLength(0)
  u.emitter.emit('update-downloaded')
  await new Promise(resolve => setImmediate(resolve))
  expect(u.installs).toHaveLength(1)
})

test('a failed download falls back to the link and drops a pending Update', async () => {
  const u = makeUpdater()

  watchAutoUpdater(u.updater, u.stopBee)
  u.emitter.emit('update-available')
  await installUpdate()
  u.emitter.emit('error', new Error('network'))
  expect(getUpdateInfo().updater).toBe('failed')
  expect(getUpdateInfo().installRequested).toBe(false)
  expect(await installUpdate()).toBe('unavailable')
})

test('an error after the download leaves it installable', async () => {
  const u = makeUpdater()

  watchAutoUpdater(u.updater, u.stopBee)
  u.emitter.emit('update-downloaded')
  u.emitter.emit('error', new Error('later check failed'))
  expect(getUpdateInfo().updater).toBe('ready')
})

test('a second click while installing does not install twice', async () => {
  const u = makeUpdater()

  watchAutoUpdater(u.updater, u.stopBee)
  u.emitter.emit('update-downloaded')
  await Promise.all([installUpdate(), installUpdate()])
  expect(u.installs).toHaveLength(1)
})

test('the notice never names a version that is not newer than this one', async () => {
  const u = makeUpdater()

  jest.useFakeTimers()
  watchAutoUpdater(u.updater, u.stopBee)
  // The daily check saw this very version as GitHub's latest…
  startUpdateChecker()
  jest.advanceTimersByTime(60_000)
  jest.useRealTimers()
  await settle()
  expect(mockFetch).toHaveBeenCalledTimes(1)
  // …then the updater found a newer one before GitHub answered again.
  mockFetch.mockReturnValue(new Promise(() => undefined))
  u.emitter.emit('update-available')
  expect(getUpdateInfo().updateAvailable).toBe(true)
  expect(getUpdateInfo().latest).toBeNull()
})

test('when the updater finds a version, the notice asks GitHub again and names it', async () => {
  const u = makeUpdater()
  const next = bump(PACKAGE_JSON.version)

  watchAutoUpdater(u.updater, u.stopBee)
  githubLatest(next)
  u.emitter.emit('update-available')
  await settle()
  expect(mockFetch).toHaveBeenCalledTimes(1)
  expect(getUpdateInfo().latest).toBe(next)
})
