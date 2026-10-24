import { app, autoUpdater, dialog } from 'electron'

import PACKAGE_JSON from '../package.json'
import { ensureApiKey } from './api-key'
import { openDashboardInBrowser } from './browser'
import { getNookVersionFromFile, writeNookVersionFile } from './config'
import { EXPECTED_BEE_VERSION, getInstalledBeeVersion, isBeeAssetReady, runDownloader } from './downloader'
import { runElectronTray } from './electron'
import { startChequebookMonitor } from './chequebook-monitor'
import { startDepthSave } from './depth-save'
import { startExtendMonitor } from './extend-monitor'
import { startSystemStampMonitor } from './system-stamp'
import { startAutoUpdates, startUpdateChecker } from './update-checker'
import { startMonitorIfNeeded } from './funding-monitor'
import { initializeBee, runKeepAliveLoop, runLauncher } from './launcher'
import { BeeManager } from './lifecycle'
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

// Nook is a tray app (the dashboard lives in the browser), so closing its last
// window must not quit it. Electron's default does: quitAndInstall closes the
// hidden splash, Nook quit before the updater could relaunch it, and an Update
// that failed took Nook down with Bee stopped (2026-10-24). Tray Quit and every
// other quit call app.quit() and still quit.
app.on('window-all-closed', () => undefined)

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

  // Auto updater (Mac, Windows) — downloads in the background; Nook's own
  // Update button (sidebar, Settings) restarts into it. Linux keeps the link.
  if (app.isPackaged && (process.platform === 'darwin' || process.platform === 'win32')) {
    void app.whenReady().then(() =>
      startAutoUpdates(autoUpdater, {
        stop: async () => {
          BeeManager.stop()
          await BeeManager.waitForSigtermToFinish()
        },
        // The keep-alive loop starts Bee again once it's wanted.
        start: () => BeeManager.setUserIntention(true),
      }),
    )
  }

  // check if the assets and the bee binary matches the desktop version
  const desktopFileVersion = getNookVersionFromFile()
  const desktopVersionChanged = desktopFileVersion !== PACKAGE_JSON.version
  const installedBeeVersion = getInstalledBeeVersion()
  // Download Bee only when it's needed: the expected version is missing, a
  // different version, or a binary that doesn't run. A new Nook with the same
  // Bee used to download it again on every update — and a download that went
  // wrong left a Bee that never started and was never replaced.
  const force = installedBeeVersion !== EXPECTED_BEE_VERSION

  logger.info(
    `Desktop version: ${PACKAGE_JSON.version}, desktop file version: ${desktopFileVersion}, ` +
      `installed Bee: ${installedBeeVersion ?? (isBeeAssetReady() ? 'not answering' : 'none')}, ` +
      `expected Bee: ${EXPECTED_BEE_VERSION}, downloading assets: ${force}`,
  )

  if (force) {
    splash.setMessage('Downloading Bee')
    await runDownloader(true)
  }

  if (desktopVersionChanged) writeNookVersionFile()

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
  startExtendMonitor()
  startDepthSave()
  startSystemStampMonitor()
  startUpdateChecker()
  runElectronTray()

  if (process.env.NODE_ENV !== 'development') openDashboardInBrowser()
  splash.hide()
  splash = undefined

  // Now that the dashboard URL works, replay any nook:// URL that arrived during startup
  flushPendingNookUrl()

  runKeepAliveLoop()
}

main().catch(errorHandler)
