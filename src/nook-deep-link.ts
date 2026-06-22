import { app } from 'electron'
import { openDashboardWithContact } from './browser'
import { logger } from './logger'

/**
 * `nook://` protocol handler — currently used for `nook://contact?…` share links.
 *
 * Mirrors the structure of `deep-link.ts` (PR #38, swarm:// handler). Coexists
 * with that module — both schemes can be registered and dispatched independently.
 *
 * Flow:
 *   OS click on `nook://contact?addr=…&wpub=…&bpub=…&name=…`
 *     → main process receives URL via `open-url` (mac) or argv / second-instance (Win, Linux)
 *     → handleNookUrl()
 *     → opens browser at /dashboard/?v=API_KEY&contact=<encoded-nook-url>
 *     → React Contacts page reads `contact` query param, switches to share-link mode, prefills
 */

let pendingUrl: string | null = null
let ready = false

/** Extract a nook:// URL from process.argv (Win/Linux pass URLs as CLI args). */
export function extractNookUrl(argv: string[]): string | null {
  return argv.find(arg => arg.startsWith('nook://')) ?? null
}

/**
 * Handle an incoming nook:// URL. If the app is ready, opens the dashboard
 * immediately. If not, queues it.
 */
export function handleNookUrl(url: string): void {
  logger.info(`Nook deep link received: ${url}`)

  if (!url.startsWith('nook://')) {
    logger.warn(`Ignoring non-nook URL: ${url}`)

    return
  }

  if (!ready) {
    pendingUrl = url
    logger.info('Queuing nook:// URL until app is ready')

    return
  }

  openDashboardWithContact(url)
}

/** Mark the app as ready and flush any queued URL. */
export function flushPendingNookUrl(): void {
  ready = true

  if (pendingUrl) {
    const url = pendingUrl

    pendingUrl = null
    logger.info(`Flushing pending nook:// URL: ${url}`)
    openDashboardWithContact(url)
  }
}

/** Register `nook://` as a protocol handler with the OS. */
export function registerNookProtocol(): void {
  if (process.defaultApp) {
    // dev mode: pass argv[1] (path to the script) as a marker
    if (process.argv.length >= 2) {
      app.setAsDefaultProtocolClient('nook', process.execPath, [process.argv[1]])
    }
  } else {
    app.setAsDefaultProtocolClient('nook')
  }
  logger.info('Registered nook:// protocol handler')
}
