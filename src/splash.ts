import { BrowserWindow, app } from 'electron'
import * as path from 'path'
import { logger } from './logger'

export interface Splash {
  hide: () => void
  setMessage: (msg: string) => void
}

export async function initSplash(): Promise<Splash> {
  await app.whenReady()

  const splashPath = path.resolve(__dirname, '..', '..', '..', 'assets', 'splash.html')
  logger.info(`Serving splash screen from path ${splashPath}`)

  const splash = new BrowserWindow({
    width: 800,
    height: 600,
    frame: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  await splash.loadURL(`file://${splashPath}`)

  return {
    hide: () => splash.hide(),
    setMessage: async (msg: string) => splash.loadURL(`file://${splashPath}?msg=${encodeURI(msg)}`),
  }
}
