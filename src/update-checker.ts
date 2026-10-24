import { existsSync, readFileSync, writeFileSync } from 'fs'

import { fetchWithTimeout } from './fetch-timeout'
import { logger } from './logger'
import { pushNotification } from './notifications'
import { getPath } from './path'
import PACKAGE_JSON from '../package.json'

/**
 * Update check (post-test feedback 2026-09-21): tell the user a newer Nook
 * exists — a bell notification, a sidebar notice and a Settings row.
 *
 * On Mac and Windows Electron's updater downloads the new version in the
 * background (startAutoUpdates below), and one "Update" button restarts into it
 * once it's downloaded (test feedback 2026-10-20). Linux, or an updater that
 * failed or hasn't got the release: the button is a download link to GitHub.
 */

const RELEASES_API = 'https://api.github.com/repos/GasperX93/nook/releases/latest'
const CHECK_INTERVAL_MS = 24 * 60 * 60_000
const INITIAL_DELAY_MS = 60_000
const STATE_FILE = 'update-check.json'

/**
 * Electron's updater: `none` = nothing found (yet), `downloading`, `ready` =
 * downloaded and waiting for a restart, `installing`, `failed` = the download
 * failed (the next check retries), `stuck` = a download that hasn't finished in
 * STUCK_AFTER_MS (only a restart starts it again), `installFailed` = Update
 * didn't restart Nook (quitting and reopening finishes it), and `unsupported`
 * (Linux, or not a packaged app).
 */
export type UpdaterState =
  | 'none'
  | 'downloading'
  | 'ready'
  | 'installing'
  | 'failed'
  | 'stuck'
  | 'installFailed'
  | 'unsupported'

const FEED_HOST = 'https://update.electronjs.org/GasperX93/nook'
const UPDATER_CHECK_INTERVAL_MS = 10 * 60_000

/**
 * Squirrel.Mac's download timeout is 20 minutes without data, and a ~140 MB
 * download on a very slow line can take an hour; one still going after two
 * hours has hung (2026-10-23: one never finished after the Mac slept
 * mid-download, and the next 20 hours of checks all said "busy").
 */
const STUCK_AFTER_MS = 2 * 60 * 60_000

/** Update was clicked but Nook is still running this long after: it didn't restart. */
const INSTALL_TIMEOUT_MS = 60_000

export interface UpdateInfo {
  current: string
  latest: string | null
  url: string | null
  updateAvailable: boolean
  updater: UpdaterState
  /** Update was clicked while still downloading: Nook restarts once it's done. */
  installRequested: boolean
}

const RELEASES_PAGE = 'https://github.com/GasperX93/nook/releases'

let latestSeen: { version: string; url: string } | null = null
let updaterState: UpdaterState = 'unsupported'
let installRequested = false
let downloadStartedAt = 0
let stuckLogged = false
/** The version Electron downloaded — what Update installs, whatever GitHub says is newest. */
let downloadedVersion: string | null = null

/** The state, with a download that has run too long reported as stuck. */
function currentUpdaterState(): UpdaterState {
  if (updaterState !== 'downloading' || Date.now() - downloadStartedAt < STUCK_AFTER_MS) return updaterState

  if (!stuckLogged) {
    stuckLogged = true
    // The user is offered the download link instead; don't restart on them
    // hours later if the download does finish.
    installRequested = false
    logger.warn('Update download seems stuck — quitting and reopening Nook starts it again')
  }

  return 'stuck'
}

export function getUpdateInfo(): UpdateInfo {
  const current = PACKAGE_JSON.version
  const state = currentUpdaterState()
  const updaterHasOne =
    state === 'downloading' ||
    state === 'ready' ||
    state === 'installing' ||
    state === 'stuck' ||
    state === 'installFailed'
  // The daily GitHub check can be older than the updater's find: never name a
  // version that isn't newer than this one ("Nook 0.7.4 is available" on 0.7.4).
  // Once one is downloaded, name that one: it's what Update installs (a newer
  // release is picked up after the restart).
  const staged =
    downloadedVersion !== null && (state === 'ready' || state === 'installing' || state === 'installFailed')
      ? { version: downloadedVersion, url: `${RELEASES_PAGE}/tag/v${downloadedVersion}` }
      : null
  const seen = staged ?? latestSeen
  const newer = seen !== null && isNewer(seen.version, current) ? seen : null

  return {
    current,
    latest: newer?.version ?? null,
    url: newer?.url ?? (updaterHasOne ? RELEASES_PAGE : null),
    updateAvailable: newer !== null || updaterHasOne,
    updater: state,
    installRequested,
  }
}

/** The part of Electron's autoUpdater Nook uses (injectable for tests). */
export interface AutoUpdaterLike {
  on(
    event: 'checking-for-update' | 'update-available' | 'update-not-available' | 'update-downloaded' | 'error',
    listener: (...args: unknown[]) => void,
  ): unknown
  setFeedURL(options: { url: string; headers?: Record<string, string> }): void
  checkForUpdates(): void
  quitAndInstall(): void
}

interface BeeControl {
  /** Stop Bee the way the tray's Quit does, before restarting into the update. */
  stop: () => Promise<void>
  /** Bring Bee back when the restart didn't happen. */
  start: () => void
}

let updater: AutoUpdaterLike | null = null
let bee: BeeControl = { stop: async () => undefined, start: () => undefined }
let checkTimer: ReturnType<typeof setInterval> | null = null
let installTimer: ReturnType<typeof setTimeout> | null = null

/**
 * Run Electron's updater: check now and every 10 minutes, and follow what it
 * does. Call once, only in a packaged app on Mac or Windows, after the app is
 * ready. Replaces update-electron-app, which kept checking every 10 minutes
 * even with an update downloaded: on a Mac that check gets "not modified" for
 * the same zip, Electron then forgets the downloaded update, and Update failed
 * with "No update available" (verified 2026-10-24).
 */
export function startAutoUpdates(autoUpdater: AutoUpdaterLike, beeControl: BeeControl): void {
  updater = autoUpdater
  bee = beeControl
  updaterState = 'none'
  autoUpdater.on('checking-for-update', () => logger.info('Update: checking'))
  autoUpdater.on('update-not-available', () => {
    logger.info('Update: none available')

    // A check that failed earlier (offline) is answered now.
    if (updaterState === 'failed') updaterState = 'none'
  })
  autoUpdater.on('update-available', () => {
    logger.info('Update: found, downloading')

    if (
      updaterState !== 'ready' &&
      updaterState !== 'installing' &&
      updaterState !== 'downloading' &&
      updaterState !== 'installFailed'
    ) {
      updaterState = 'downloading'
      downloadStartedAt = Date.now()
      stuckLogged = false
    }

    // Ask GitHub again so the notice names the version being downloaded.
    void runUpdateCheck()
  })
  autoUpdater.on('update-downloaded', (...args: unknown[]) => {
    // (event, releaseNotes, releaseName, …): the feed's name, e.g. "v0.7.5".
    const name = typeof args[2] === 'string' ? args[2].replace(/^v/, '') : ''

    downloadedVersion = /^\d+\.\d+\.\d+$/.test(name) ? name : null
    logger.info(`Update: downloaded${downloadedVersion ? ` ${downloadedVersion}` : ''}, ready to install`)
    // No more checks: one now would make Electron forget this download.
    stopChecks()
    const tookTooLong = Date.now() - downloadStartedAt >= STUCK_AFTER_MS

    updaterState = 'ready'

    // An Update click is acted on only while the user could still see it waiting;
    // after a stuck download they were shown the download link instead.
    if (installRequested && !tookTooLong) void installUpdate()
    else installRequested = false
  })
  autoUpdater.on('error', error => {
    const message = (error as Error)?.message ?? String(error)

    // A check while the previous check or download still runs is refused; the
    // download goes on, so nothing has failed.
    if (isBusyError(error)) {
      logger.debug(`Update: check skipped, the previous one is still running (${message})`)

      return
    }

    if (updaterState === 'installing') {
      installDidNotRestart(message)

      return
    }

    if (updaterState === 'none' || updaterState === 'failed') logger.info(`Update check failed: ${message}`)
    else logger.error(`Update download failed: ${message}`)

    // A download already finished stays installable; otherwise offer the link.
    // The next check retries it.
    if (updaterState !== 'ready' && updaterState !== 'installFailed') {
      updaterState = 'failed'
      installRequested = false
    }
  })

  // After the listeners: setFeedURL reports a bad signature as an 'error' event.
  autoUpdater.setFeedURL({
    url: `${FEED_HOST}/${process.platform}-${process.arch}/${PACKAGE_JSON.version}`,
    headers: { 'User-Agent': `Nook/${PACKAGE_JSON.version} (${process.platform}: ${process.arch})` },
  })

  const check = () => {
    // Nothing to ask while a download runs or one is waiting to be installed.
    if (updaterState !== 'none' && updaterState !== 'failed') return
    autoUpdater.checkForUpdates()
  }

  check()
  checkTimer = setInterval(check, UPDATER_CHECK_INTERVAL_MS)
}

function stopChecks(): void {
  if (checkTimer) clearInterval(checkTimer)
  checkTimer = null
}

/**
 * Update didn't restart Nook (an updater error, or still running after
 * INSTALL_TIMEOUT_MS). Bring Bee back; the update itself is already prepared,
 * so quitting and reopening Nook finishes it (Mac: ShipIt installs on quit,
 * verified 2026-10-24; Windows: the next start runs the newest version).
 */
function installDidNotRestart(reason: string): void {
  if (updaterState !== 'installing') return

  if (installTimer) clearTimeout(installTimer)
  installTimer = null
  logger.error(`Update didn't restart Nook (${reason}) — starting Bee again; quit and reopen Nook to finish`)
  updaterState = 'installFailed'
  installRequested = false
  bee.start()
}

/**
 * "A check is already running": Squirrel.Mac's RACCommandErrorNotEnabled, or
 * Squirrel.Windows' "AutoUpdater process with arguments … is already running".
 */
function isBusyError(error: unknown): boolean {
  const { domain, code, message } = (error ?? {}) as { domain?: string; code?: number; message?: string }

  return (
    (domain === 'RACCommandErrorDomain' && code === 1) || /command is disabled|is already running/i.test(message ?? '')
  )
}

/**
 * The Update button. Downloaded: stop Bee and restart into the new version.
 * Still downloading: restart as soon as it's done. Otherwise nothing to do.
 */
export async function installUpdate(): Promise<'installing' | 'waiting' | 'unavailable'> {
  if (!updater) return 'unavailable'

  const state = currentUpdaterState()

  if (state === 'installing') return 'installing'

  if (state === 'downloading') {
    installRequested = true

    return 'waiting'
  }

  if (state !== 'ready') return 'unavailable'
  updaterState = 'installing'
  logger.info('Update: stopping Bee and restarting into the new version')
  await bee.stop()
  installTimer = setTimeout(() => installDidNotRestart('still running'), INSTALL_TIMEOUT_MS)
  updater.quitAndInstall()

  return 'installing'
}

export function resetUpdaterForTests(): void {
  stopChecks()

  if (installTimer) clearTimeout(installTimer)
  installTimer = null
  bee = { stop: async () => undefined, start: () => undefined }
  updater = null
  updaterState = 'unsupported'
  installRequested = false
  latestSeen = null
  downloadedVersion = null
  downloadStartedAt = 0
  stuckLogged = false
}

/** True when a is a strictly newer x.y.z than b. Non-numeric parts = not newer. */
function isNewer(a: string, b: string): boolean {
  const pa = a.replace(/^v/, '').split('.').map(Number)
  const pb = b.replace(/^v/, '').split('.').map(Number)

  if (pa.some(Number.isNaN) || pb.some(Number.isNaN)) return false

  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) > (pb[i] ?? 0)) return true

    if ((pa[i] ?? 0) < (pb[i] ?? 0)) return false
  }

  return false
}

function alreadyNotified(version: string): boolean {
  try {
    return (
      existsSync(getPath(STATE_FILE)) && JSON.parse(readFileSync(getPath(STATE_FILE), 'utf-8')).notified === version
    )
  } catch {
    return false
  }
}

async function runUpdateCheck(): Promise<void> {
  try {
    const response = await fetchWithTimeout(
      RELEASES_API,
      { headers: { accept: 'application/vnd.github+json' } },
      15_000,
    )

    if (!response.ok) return
    const release = (await response.json()) as { tag_name?: string; html_url?: string; draft?: boolean }

    if (!release.tag_name || release.draft) return
    const version = release.tag_name.replace(/^v/, '')

    latestSeen = { version, url: release.html_url ?? 'https://github.com/GasperX93/nook/releases' }

    if (!isNewer(version, PACKAGE_JSON.version)) return

    // One bell per version — the Settings row keeps showing it regardless.
    if (alreadyNotified(version)) return
    writeFileSync(getPath(STATE_FILE), JSON.stringify({ notified: version }))
    pushNotification({
      type: 'info',
      title: `Nook ${version} is available`,
      body: `You're on ${PACKAGE_JSON.version}. Update from the sidebar or Settings.`,
      link: '/settings',
    })
    logger.info(`Update available: ${PACKAGE_JSON.version} → ${version}`)
  } catch (error) {
    // Offline or rate-limited — quiet; the next daily check retries.
    logger.debug(`Update check failed: ${(error as Error).message}`)
  }
}

export function startUpdateChecker(): void {
  void getPath('')
  setTimeout(() => {
    void runUpdateCheck()
    setInterval(async () => runUpdateCheck(), CHECK_INTERVAL_MS)
  }, INITIAL_DELAY_MS)
}
