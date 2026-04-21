import { app, Menu, Tray } from 'electron'
import opener from 'opener'
import { openDashboardInBrowser } from './browser'
import { runLauncher } from './launcher'
import { BeeManager } from './lifecycle'
import { getAssetPath, paths } from './path'

let tray: Tray

export function rebuildElectronTray() {
  if (!tray) {
    return
  }
  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Open Web UI',
      click: openDashboardInBrowser,
    },
    { type: 'separator' },
    {
      label: BeeManager.isRunning() ? 'Stop Bee' : 'Start Bee',
      click: () => {
        if (BeeManager.isRunning()) {
          BeeManager.stop()
        } else {
          runLauncher()
        }
      },
    },
    { type: 'separator' },
    {
      label: 'Logs',
      click: async () => {
        opener(paths.log)
      },
    },
    {
      label: 'Quit',
      click: async () => {
        BeeManager.stop()
        await BeeManager.waitForSigtermToFinish()
        app.quit()
      },
    },
  ])
  tray.setContextMenu(contextMenu)
}

function getTrayIcon() {
  return getAssetPath('nookTray-N.png')
}

export function runElectronTray() {
  app.whenReady().then(() => {
    if (app.dock) {
      app.dock.setIcon(getAssetPath('nook_N_transparent_master.png'))
      app.dock.hide()
    }

    tray = new Tray(getTrayIcon())
    rebuildElectronTray()
  })
}
