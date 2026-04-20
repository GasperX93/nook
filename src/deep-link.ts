import { app } from 'electron'
import { logger } from './logger'

let pendingUrl: string | null = null
let ready = false

/**
 * Extract a swarm:// URL from process.argv (Windows/Linux pass URLs as CLI args).
 */
export function extractSwarmUrl(argv: string[]): string | null {
  return argv.find(arg => arg.startsWith('swarm://')) ?? null
}

/**
 * Handle an incoming swarm:// URL. If the app is ready, opens the dashboard
 * immediately. If not, queues it for later.
 */
export function handleSwarmUrl(url: string): void {
  logger.info(`Deep link received: ${url}`)

  if (!url.startsWith('swarm://')) {
    logger.warn(`Ignoring non-swarm URL: ${url}`)

    return
  }

  if (ready) {
    openDashboardWithShare(url)
  } else {
    pendingUrl = url
    logger.info('App not ready, URL queued')
  }
}

/**
 * Called once the server + port + API key are all available.
 * Flushes any pending URL. Returns true if a URL was flushed.
 */
export function markDeepLinkReady(): boolean {
  ready = true

  if (pendingUrl) {
    logger.info(`Flushing queued deep link: ${pendingUrl}`)
    openDashboardWithShare(pendingUrl)
    pendingUrl = null

    return true
  }

  return false
}

/**
 * Register protocol handlers. Must be called before app.ready on macOS.
 */
export function registerProtocolHandlers(): void {
  if (process.defaultApp) {
    if (process.argv.length >= 2) {
      app.setAsDefaultProtocolClient('swarm', process.execPath, [process.argv[1]])
    }
  } else {
    app.setAsDefaultProtocolClient('swarm')
  }

  app.on('open-url', (event, url) => {
    event.preventDefault()
    handleSwarmUrl(url)
  })
}

function openDashboardWithShare(swarmUrl: string): void {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { openDashboardWithShareLink } = require('./browser')
  openDashboardWithShareLink(swarmUrl)
}
