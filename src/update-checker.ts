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
 * On Mac and Windows Electron's updater (update-electron-app) downloads the
 * new version in the background. Its own "Restart?" dialog is off; Nook shows
 * one "Update" button instead (test feedback 2026-10-20), which restarts into
 * the new version once it's downloaded. Linux, or an updater that failed or
 * hasn't got the release: the button is a download link to GitHub.
 */

const RELEASES_API = 'https://api.github.com/repos/GasperX93/nook/releases/latest'
const CHECK_INTERVAL_MS = 24 * 60 * 60_000
const INITIAL_DELAY_MS = 60_000
const STATE_FILE = 'update-check.json'

/**
 * Electron's updater: `none` = nothing found (yet), `downloading`, `ready` =
 * downloaded and waiting for a restart, `installing`, `failed`, `stuck` = a
 * download that hasn't finished in STUCK_AFTER_MS (only a restart starts it
 * again), and `unsupported` (Linux, or not a packaged app).
 */
export type UpdaterState = 'none' | 'downloading' | 'ready' | 'installing' | 'failed' | 'stuck' | 'unsupported'

/**
 * Squirrel.Mac's own download timeout is 20 minutes without data; a download
 * still going after an hour has hung (2026-10-23: one never finished after the
 * Mac slept mid-download, and the next 20 hours of checks all said "busy").
 */
const STUCK_AFTER_MS = 60 * 60_000

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
  const updaterHasOne = state === 'downloading' || state === 'ready' || state === 'installing' || state === 'stuck'
  // The daily GitHub check can be older than the updater's find: never name a
  // version that isn't newer than this one ("Nook 0.7.4 is available" on 0.7.4).
  const newer = latestSeen !== null && isNewer(latestSeen.version, current) ? latestSeen : null

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
  on(event: 'update-available' | 'update-downloaded' | 'error', listener: (...args: unknown[]) => void): unknown
  quitAndInstall(): void
}

let updater: AutoUpdaterLike | null = null
let stopBee: () => Promise<void> = async () => undefined

/**
 * Follow Electron's updater. Call once, only in a packaged app on Mac or
 * Windows; `beforeInstall` stops Bee the way the tray's Quit does.
 */
export function watchAutoUpdater(autoUpdater: AutoUpdaterLike, beforeInstall: () => Promise<void>): void {
  updater = autoUpdater
  stopBee = beforeInstall
  updaterState = 'none'
  autoUpdater.on('update-available', () => {
    if (updaterState !== 'ready' && updaterState !== 'installing' && updaterState !== 'downloading') {
      updaterState = 'downloading'
      downloadStartedAt = Date.now()
      stuckLogged = false
    }

    // Ask GitHub again so the notice names the version being downloaded.
    void runUpdateCheck()
  })
  autoUpdater.on('update-downloaded', () => {
    logger.info('Update downloaded — ready to install')
    updaterState = 'ready'

    if (installRequested) void installUpdate()
  })
  autoUpdater.on('error', error => {
    // update-electron-app checks every 10 minutes; while a check and its
    // download are still running, Squirrel.Mac refuses the next one with this
    // error. The download goes on, so nothing has failed.
    if (isBusyError(error)) {
      logger.debug('Update check skipped: the previous check or download is still running')

      return
    }
    logger.error(`Update download failed: ${(error as Error)?.message ?? error}`)

    // A download already finished stays installable; otherwise offer the link.
    // The next check retries it.
    if (updaterState !== 'ready' && updaterState !== 'installing') {
      updaterState = 'failed'
      installRequested = false
    }
  })
}

/** Squirrel.Mac's "a check is already running" (RACCommandErrorNotEnabled). */
function isBusyError(error: unknown): boolean {
  const { domain, code, message } = (error ?? {}) as { domain?: string; code?: number; message?: string }

  return (domain === 'RACCommandErrorDomain' && code === 1) || /command is disabled/i.test(message ?? '')
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
  await stopBee()
  updater.quitAndInstall()

  return 'installing'
}

export function resetUpdaterForTests(): void {
  updater = null
  updaterState = 'unsupported'
  installRequested = false
  latestSeen = null
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
