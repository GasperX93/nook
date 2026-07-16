import { spawn } from 'child_process'
import { mkdirSync, writeFileSync } from 'fs'
import { platform } from 'os'
import { v4 } from 'uuid'
import { rebuildElectronTray } from './electron'
import { fetchWithTimeout } from './fetch-timeout'
import { BeeManager } from './lifecycle'
import { RotatingLogWriter } from './log-rotator'
import { logger } from './logger'
import { checkPath, getLogPath, getPath } from './path'
import { canAttemptStart, recordExit, recordStart, shouldRestartForWedge } from './supervisor'

/** Liveness probes for the wedge check (see supervisor.ts). */
const livenessProbes = {
  getPeerCount: async (): Promise<number | null> => {
    try {
      const res = await fetchWithTimeout('http://localhost:1633/peers', {}, 5_000)

      if (!res.ok) return null
      const data = (await res.json()) as { peers?: unknown[] }

      return Array.isArray(data.peers) ? data.peers.length : null
    } catch {
      return null
    }
  },
  hasInternet: async (): Promise<boolean> => {
    try {
      const res = await fetchWithTimeout('https://api.github.com', { method: 'HEAD' }, 5_000)

      return res.ok || res.status < 500
    } catch {
      return false
    }
  },
}

export function runKeepAliveLoop() {
  setInterval(async () => {
    const now = Date.now()

    if (!BeeManager.isRunning() && BeeManager.shouldRestart()) {
      if (canAttemptStart(now)) runLauncher()

      return
    }

    // Sleep/wake wedge detection: a running node with 0 peers for too long
    // (while the host has internet) never self-recovers — kill it and let the
    // next tick relaunch with fresh p2p state.
    if (BeeManager.isRunning() && BeeManager.shouldRestart()) {
      if (await shouldRestartForWedge(now, livenessProbes)) {
        BeeManager.kill()
      }
    }
  }, 10000)
}

function getBeeExecutable() {
  if (platform() === 'win32') {
    return 'bee.exe'
  }

  return 'bee'
}

function createConfiguration() {
  return `api-addr: 127.0.0.1:1633
swap-enable: false
mainnet: true
full-node: false
cors-allowed-origins: '*'
skip-postage-snapshot: false
resolver-options: https://cloudflare-eth.com
data-dir: ${getPath('data-dir')}
password: ${v4()}
storage-incentives-enable: false`
}

export async function initializeBee() {
  if (!checkPath('config.yaml')) {
    logger.info('Creating new Bee config.yaml')
    writeFileSync(getPath('config.yaml'), createConfiguration())
  }

  const configPath = getPath('config.yaml')
  logger.debug(`Executing process: bee init --config=${configPath}`)

  return runProcess(getPath(getBeeExecutable()), ['init', `--config=${configPath}`], new AbortController())
}

export async function runLauncher() {
  const abortController = new AbortController()

  if (!checkPath('data-dir')) {
    mkdirSync(getPath('data-dir'))
  }

  BeeManager.setUserIntention(true)
  const subprocess = launchBee(abortController).catch(reason => {
    logger.error(reason)
  })
  recordStart(Date.now())
  BeeManager.signalRunning(abortController, subprocess)
  rebuildElectronTray()
  await subprocess
  logger.info('Bee subprocess finished running')
  recordExit(Date.now())
  abortController.abort()
  BeeManager.signalStopped()
  rebuildElectronTray()
}

async function launchBee(abortController?: AbortController) {
  if (!abortController) {
    abortController = new AbortController()
  }
  const configPath = getPath('config.yaml')

  logger.debug(`Executing process: bee start --config=${configPath}`)

  return runProcess(getPath(getBeeExecutable()), ['start', `--config=${configPath}`], abortController)
}

async function runProcess(command: string, args: string[], abortController: AbortController): Promise<void> {
  return new Promise((resolve, reject) => {
    const subprocess = spawn(command, args, { signal: abortController.signal, killSignal: 'SIGINT' })

    // Print the logs to console
    subprocess.stdout.pipe(process.stdout)
    subprocess.stderr.pipe(process.stderr)

    // Also store the logs to log dir — rotation-safe writer, see #80
    const logWriter = new RotatingLogWriter(getLogPath('bee'), {
      maxBytes: 500_000,
      maxFiles: 10,
      symlinkPath: getLogPath('bee.current.log'),
    })

    subprocess.stdout.on('data', chunk => logWriter.write(chunk))
    subprocess.stderr.on('data', chunk => logWriter.write(chunk))

    subprocess.on('close', code => {
      void logWriter.close()

      if (code === 0) {
        resolve()
      } else {
        reject(`process exited with non-zero status code: ${code}`)
      }
    })
    subprocess.on('error', error => {
      reject(error)
    })
  })
}
