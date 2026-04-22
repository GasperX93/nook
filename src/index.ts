import { app, dialog } from 'electron'
import { updateElectronApp } from 'update-electron-app'

import PACKAGE_JSON from '../package.json'
import { ensureApiKey } from './api-key'
import { openDashboardInBrowser } from './browser'
import { getNookVersionFromFile, writeNookVersionFile } from './config'
import { runDownloader } from './downloader'
import { runElectronTray } from './electron'
import { startChequebookMonitor } from './chequebook-monitor'
import { startMonitorIfNeeded } from './funding-monitor'
import { initializeBee, runKeepAliveLoop, runLauncher } from './launcher'
import { logger } from './logger'
import { extractNookUrl, flushPendingNookUrl, handleNookUrl, registerNookProtocol } from './nook-deep-link'
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

if (squirrelInstallingExecution) {
  app.quit()
}

// Register nook:// protocol handler. Doing this at module load so it runs
// before the app's `ready` event, which is required for OS handoff to work.
registerNookProtocol()

// macOS: OS delivers nook:// URLs via the open-url event
app.on('open-url', (event, url) => {
  if (url.startsWith('nook://')) {
    event.preventDefault()
    handleNookUrl(url)
  }
})

// Windows / Linux: OS launches a second instance with the URL in argv
app.on('second-instance', (_event, argv) => {
  const url = extractNookUrl(argv)

  if (url) handleNookUrl(url)
})

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

  // Check argv for a nook:// URL handed in at launch time (Win/Linux)
  const initialNookUrl = extractNookUrl(process.argv)

  if (initialNookUrl) handleNookUrl(initialNookUrl)

  if (!getStatus().config) {
    logger.info('No Bee config found, initializing Bee')
    splash.setMessage('Initializing Bee')
    await initializeBee()
  }

  runLauncher().catch(errorHandler)
  startMonitorIfNeeded()
  startChequebookMonitor()
  runElectronTray()

  if (process.env.NODE_ENV !== 'development') openDashboardInBrowser()
  splash.hide()
  splash = undefined

  // Now that the dashboard URL works, replay any nook:// URL that arrived during startup
  flushPendingNookUrl()

  runKeepAliveLoop()
}

main().catch(errorHandler)
