import { app, dialog } from 'electron'
import { updateElectronApp } from 'update-electron-app'

import PACKAGE_JSON from '../package.json'
import { ensureApiKey } from './api-key'
import { openDashboardInBrowser } from './browser'
import { registerProtocolHandlers, markDeepLinkReady, handleSwarmUrl, extractSwarmUrl } from './deep-link'
import { getNookVersionFromFile, writeNookVersionFile } from './config'
import { runDownloader } from './downloader'
import { runElectronTray } from './electron'
import { startChequebookMonitor } from './chequebook-monitor'
import { startMonitorIfNeeded } from './funding-monitor'
import { initializeBee, runKeepAliveLoop, runLauncher } from './launcher'
import { logger } from './logger'
import { findFreePort } from './port'
import { runServer } from './server'
import { getStatus } from './status'

// TODO: Add types definition
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import squirrelInstallingExecution from 'electron-squirrel-startup'
import { runMigrations } from './migration'
import { initSplash, Splash } from './splash'

runMigrations()
registerProtocolHandlers()

// Single-instance lock must be acquired early, before app.ready.
// On macOS, clicking a swarm:// link while the app is running triggers open-url
// (handled in registerProtocolHandlers). On Windows/Linux, it triggers second-instance.
const gotTheLock = app.requestSingleInstanceLock()

if (!gotTheLock) {
  app.quit()
  // app.quit() is async — prevent main() from running in the second instance
  process.exit(0)
}

app.on('second-instance', (_event, argv) => {
  const url = extractSwarmUrl(argv)

  if (url) {
    handleSwarmUrl(url)
  }
})

if (squirrelInstallingExecution) {
  app.quit()
}

function errorHandler(e: Error | string) {
  if (splash) {
    splash.hide()
  }

  if (typeof e !== 'string') {
    e = e.message
  }

  logger.error(e)
  dialog.showErrorBox('There was an error in Nook', e)
}

let splash: Splash | undefined

async function main() {
  logger.info(`Nook version: ${PACKAGE_JSON.version} (${process.env.NODE_ENV ?? 'production'})`)

  splash = await initSplash()

  // Auto updater
  updateElectronApp({
    logger: {
      log: (...args) => logger.info(...args),
      info: (...args) => logger.info(...args),
      error: (...args) => logger.error(...args),
      warn: (...args) => logger.warn(...args),
    },
  })

  // check if the assets and the bee binary matches the desktop version
  const desktopFileVersion = getNookVersionFromFile()
  const force = desktopFileVersion !== PACKAGE_JSON.version

  logger.info(
    `Desktop version: ${PACKAGE_JSON.version}, desktop file version: ${desktopFileVersion}, downloading assets: ${force}`,
  )

  if (force) {
    splash.setMessage('Downloading Bee')
    await runDownloader(true)
    writeNookVersionFile()
  }

  ensureApiKey()
  await findFreePort()
  runServer()

  if (!getStatus().config) {
    logger.info('No Bee config found, initializing Bee')
    splash.setMessage('Initializing Bee')
    await initializeBee()
  }

  // Check if app was launched from a swarm:// URL (Windows/Linux cold start)
  const initialUrl = extractSwarmUrl(process.argv)

  if (initialUrl) handleSwarmUrl(initialUrl)

  runLauncher().catch(errorHandler)
  startMonitorIfNeeded()
  startChequebookMonitor()
  runElectronTray()

  const deepLinkHandled = markDeepLinkReady()

  if (!deepLinkHandled && process.env.NODE_ENV !== 'development') openDashboardInBrowser()
  splash.hide()
  splash = undefined

  runKeepAliveLoop()
}

main().catch(errorHandler)
