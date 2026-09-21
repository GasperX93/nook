import { existsSync, readFileSync, writeFileSync } from 'fs'

import { fetchWithTimeout } from './fetch-timeout'
import { logger } from './logger'
import { pushNotification } from './notifications'
import { getPath } from './path'
import PACKAGE_JSON from '../package.json'

/**
 * Update check, phase 1 (post-test feedback 2026-09-21): tell the user a
 * newer Nook exists — a bell notification plus a Settings → General row —
 * and link the download. No self-updating yet; that's phase 2 (Squirrel),
 * which deserves its own test cycle.
 */

const RELEASES_API = 'https://api.github.com/repos/GasperX93/nook/releases/latest'
const CHECK_INTERVAL_MS = 24 * 60 * 60_000
const INITIAL_DELAY_MS = 60_000
const STATE_FILE = 'update-check.json'

export interface UpdateInfo {
  current: string
  latest: string | null
  url: string | null
  updateAvailable: boolean
}

let latestSeen: { version: string; url: string } | null = null

export function getUpdateInfo(): UpdateInfo {
  const current = PACKAGE_JSON.version

  return {
    current,
    latest: latestSeen?.version ?? null,
    url: latestSeen?.url ?? null,
    updateAvailable: latestSeen !== null && isNewer(latestSeen.version, current),
  }
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
      body: `You're on ${PACKAGE_JSON.version}. Open Settings to download the update.`,
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
