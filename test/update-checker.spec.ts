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
  startAutoUpdates,
  startUpdateChecker,
} from '../src/update-checker'

// Nook's updater: check every 10 minutes until an update is downloaded, then
// stop (a later check made Electron forget it); the Update button restarts
// into it, waits for one still downloading, falls back to the download link
// when a download failed or hung, and brings Bee back when Update didn't
// restart Nook.

const TEN_MINUTES = 10 * 60_000
const HOUR = 60 * 60_000

function makeUpdater(options: { installError?: string } = {}) {
  const emitter = new EventEmitter()
  const installs: number[] = []
  const feeds: string[] = []
  let checks = 0
  const updater: AutoUpdaterLike = {
    on: (event, listener) => emitter.on(event, listener),
    setFeedURL: ({ url }) => feeds.push(url),
    checkForUpdates: () => {
      checks++
    },
    quitAndInstall: () => {
      installs.push(Date.now())

      // Electron reports a failed install right away, as an updater error.
      if (options.installError) emitter.emit('error', new Error(options.installError))
    },
  }
  const bee = { stops: 0, starts: 0 }
  const control = {
    stop: async () => {
      bee.stops++
    },
    start: () => {
      bee.starts++
    },
  }

  return { emitter, updater, installs, feeds, bee, control, checks: () => checks }
}

/** Start the updater on a fake one; the first check runs right away. */
function started(options: { installError?: string } = {}) {
  const u = makeUpdater(options)

  startAutoUpdates(u.updater, u.control)

  return u
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

// Squirrel.Mac refuses a check while the previous check and its download run.
function macBusyError() {
  return Object.assign(new Error('The command is disabled and cannot be executed'), {
    domain: 'RACCommandErrorDomain',
    code: 1,
  })
}

// Squirrel.Windows' version of the same.
function windowsBusyError() {
  return new Error('AutoUpdater process with arguments --checkForUpdate,https://x is already running')
}

beforeEach(() => {
  resetUpdaterForTests()
  mockFetch.mockReset()
  githubLatest(PACKAGE_JSON.version)
})
afterEach(() => {
  resetUpdaterForTests()
  jest.useRealTimers()
})
afterAll(() => rmSync('test/data/update-checker-spec', { recursive: true, force: true }))

test('without the updater (Linux, dev): nothing to install, download link only', async () => {
  expect(getUpdateInfo().updater).toBe('unsupported')
  expect(await installUpdate()).toBe('unavailable')
})

test('checks now and every 10 minutes, pauses while downloading, and stops once downloaded', () => {
  jest.useFakeTimers()
  const u = started()

  expect(u.feeds).toEqual([
    `https://update.electronjs.org/GasperX93/nook/${process.platform}-${process.arch}/${PACKAGE_JSON.version}`,
  ])
  expect(u.checks()).toBe(1)
  jest.advanceTimersByTime(TEN_MINUTES)
  expect(u.checks()).toBe(2)
  u.emitter.emit('update-available')
  jest.advanceTimersByTime(TEN_MINUTES)
  expect(u.checks()).toBe(2)
  u.emitter.emit('update-downloaded')
  // The check that made Electron forget the download (2026-10-24) never runs.
  jest.advanceTimersByTime(3 * HOUR)
  expect(u.checks()).toBe(2)
  expect(getUpdateInfo().updater).toBe('ready')
})

test('a check that failed (offline) is retried, and a later "none available" clears it', () => {
  jest.useFakeTimers()
  const u = started()

  u.emitter.emit('error', new Error('The Internet connection appears to be offline.'))
  expect(getUpdateInfo().updater).toBe('failed')
  jest.advanceTimersByTime(TEN_MINUTES)
  expect(u.checks()).toBe(2)
  u.emitter.emit('update-not-available')
  expect(getUpdateInfo().updater).toBe('none')
})

test('downloaded: Update stops Bee, then restarts into the new version', async () => {
  const u = started()

  u.emitter.emit('update-available')
  expect(getUpdateInfo().updater).toBe('downloading')
  expect(getUpdateInfo().updateAvailable).toBe(true)
  u.emitter.emit('update-downloaded')
  expect(getUpdateInfo().updater).toBe('ready')
  expect(await installUpdate()).toBe('installing')
  expect(u.bee.stops).toBe(1)
  expect(u.installs).toHaveLength(1)
})

test('still downloading: Update waits and restarts once the download is done', async () => {
  const u = started()

  u.emitter.emit('update-available')
  expect(await installUpdate()).toBe('waiting')
  expect(getUpdateInfo().installRequested).toBe(true)
  expect(u.installs).toHaveLength(0)
  u.emitter.emit('update-downloaded')
  await settle()
  expect(u.installs).toHaveLength(1)
})

test('a failed download falls back to the link and drops a pending Update', async () => {
  const u = started()

  u.emitter.emit('update-available')
  await installUpdate()
  u.emitter.emit('error', new Error('network'))
  expect(getUpdateInfo().updater).toBe('failed')
  expect(getUpdateInfo().installRequested).toBe(false)
  expect(await installUpdate()).toBe('unavailable')
})

test('an error after the download leaves it installable', () => {
  const u = started()

  u.emitter.emit('update-downloaded')
  u.emitter.emit('error', new Error('later check failed'))
  expect(getUpdateInfo().updater).toBe('ready')
})

test('a second click while installing does not install twice', async () => {
  const u = started()

  u.emitter.emit('update-downloaded')
  await Promise.all([installUpdate(), installUpdate()])
  expect(u.installs).toHaveLength(1)
})

test('Update that fails to install brings Bee back and says to quit and reopen (2026-10-24)', async () => {
  const u = started({ installError: "No update available, can't quit and install" })

  u.emitter.emit('update-available')
  u.emitter.emit('update-downloaded')
  expect(await installUpdate()).toBe('installing')
  const info = getUpdateInfo()

  expect(u.bee.stops).toBe(1)
  expect(u.bee.starts).toBe(1)
  expect(info.updater).toBe('installFailed')
  expect(info.updateAvailable).toBe(true)
  expect(info.installRequested).toBe(false)
  // Not "Updating…" forever, and no second attempt from the button.
  expect(await installUpdate()).toBe('unavailable')
})

test('Nook still running 30 s after Update: Bee comes back, quit and reopen', async () => {
  jest.useFakeTimers()
  const u = started()

  u.emitter.emit('update-available')
  u.emitter.emit('update-downloaded')
  await installUpdate()
  expect(getUpdateInfo().updater).toBe('installing')
  jest.advanceTimersByTime(29_000)
  expect(u.bee.starts).toBe(0)
  jest.advanceTimersByTime(2_000)
  expect(u.bee.starts).toBe(1)
  expect(getUpdateInfo().updater).toBe('installFailed')
})

test('the notice never names a version that is not newer than this one', async () => {
  jest.useFakeTimers()
  const u = started()

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
  const u = started()
  const next = bump(PACKAGE_JSON.version)

  githubLatest(next)
  u.emitter.emit('update-available')
  await settle()
  expect(mockFetch).toHaveBeenCalledTimes(1)
  expect(getUpdateInfo().latest).toBe(next)
})

test.each([
  ['Mac', macBusyError],
  ['Windows', windowsBusyError],
])('a "busy" check while downloading (%s) is not a failed download', async (_platform, busyError) => {
  const u = started()

  u.emitter.emit('update-available')
  expect(await installUpdate()).toBe('waiting')
  u.emitter.emit('error', busyError())
  expect(getUpdateInfo().updater).toBe('downloading')
  expect(getUpdateInfo().installRequested).toBe(true)
  u.emitter.emit('update-downloaded')
  await settle()
  expect(u.installs).toHaveLength(1)
})

test('a real download error offers the link, and the next check downloads again', () => {
  const u = started()

  u.emitter.emit('update-available')
  u.emitter.emit('error', new Error('The network connection was lost.'))
  expect(getUpdateInfo().updater).toBe('failed')
  u.emitter.emit('update-available')
  expect(getUpdateInfo().updater).toBe('downloading')
})

test('a download that never finishes is reported stuck: the link, no waiting click', async () => {
  const now = jest.spyOn(Date, 'now')

  try {
    now.mockReturnValue(1_000_000)
    const u = started()

    u.emitter.emit('update-available')
    await installUpdate()
    // A very slow line can take over an hour…
    now.mockReturnValue(1_000_000 + 119 * 60_000)
    expect(getUpdateInfo().updater).toBe('downloading')
    // …after two hours it's stuck.
    now.mockReturnValue(1_000_000 + 121 * 60_000)
    const info = getUpdateInfo()

    expect(info.updater).toBe('stuck')
    expect(info.updateAvailable).toBe(true)
    expect(info.url).not.toBeNull()
    expect(info.installRequested).toBe(false)
    expect(await installUpdate()).toBe('unavailable')

    // If it does finish after all, Update works again, but no surprise restart.
    u.emitter.emit('update-downloaded')
    await settle()
    expect(getUpdateInfo().updater).toBe('ready')
    expect(u.installs).toHaveLength(0)
  } finally {
    now.mockRestore()
  }
})

test('no surprise restart after a stuck download, even if nobody looked at the page', async () => {
  const now = jest.spyOn(Date, 'now')

  try {
    now.mockReturnValue(0)
    const u = started()

    u.emitter.emit('update-available')
    await installUpdate()
    // Nothing asks for the state while it hangs; it finishes three hours later.
    now.mockReturnValue(3 * HOUR)
    u.emitter.emit('update-downloaded')
    await settle()
    expect(u.installs).toHaveLength(0)
    expect(getUpdateInfo().updater).toBe('ready')
    expect(getUpdateInfo().installRequested).toBe(false)
  } finally {
    now.mockRestore()
  }
})

test('a later "update found" during a download does not restart the stuck clock', () => {
  const now = jest.spyOn(Date, 'now')

  try {
    now.mockReturnValue(0)
    const u = started()

    u.emitter.emit('update-available')
    now.mockReturnValue(110 * 60_000)
    u.emitter.emit('update-available')
    now.mockReturnValue(121 * 60_000)
    expect(getUpdateInfo().updater).toBe('stuck')
  } finally {
    now.mockRestore()
  }
})
