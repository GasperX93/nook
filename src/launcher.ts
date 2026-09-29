import { spawn } from 'child_process'
import { mkdirSync, writeFileSync } from 'fs'
import { platform } from 'os'
import { v4 } from 'uuid'
import { rebuildElectronTray } from './electron'
import { fetchWithTimeout } from './fetch-timeout'
import { mayLaunchBee } from './foreign-bee'
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

/** A watch-only port check is running (it can take seconds — never overlap). */
let watchInFlight = false

/**
 * The user stopped Nook's node (F-1): don't start anything, but keep an eye
 * on its ports. Another app's node (e.g. Swarm Desktop) can take them while
 * ours is off, and without this check nothing noticed — the dashboard showed
 * that node's drives as if they were Nook's. mayLaunchBee() only records what
 * it finds (foreign → blocking screen, gone → cleared); it never launches.
 */
async function watchPortsWhileStopped(): Promise<void> {
  if (watchInFlight) return
  watchInFlight = true

  try {
    await mayLaunchBee()
  } finally {
    watchInFlight = false
  }
}

export function runKeepAliveLoop() {
  setInterval(async () => {
    const now = Date.now()

    if (!BeeManager.isRunning()) {
      if (BeeManager.shouldRestart()) {
        if (canAttemptStart(now)) runLauncher()
      } else {
        await watchPortsWhileStopped()
      }

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
resolver-options: https://ethereum-rpc.publicnode.com
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

/** A launch is between its port check and signalRunning (see runLauncher). */
let launchInFlight = false

export async function runLauncher() {
  const abortController = new AbortController()

  if (!checkPath('data-dir')) {
    mkdirSync(getPath('data-dir'))
  }

  BeeManager.setUserIntention(true)

  // R5-11: never start a second Bee on taken ports (it crash-loops) and never
  // treat a foreign node as ours. The keep-alive loop re-checks every 10 s.
  // Only one launch at a time: the port check can take seconds, and a
  // keep-alive tick, /restart or the funding switch landing meanwhile would
  // otherwise also see the ports free and start a second Bee.
  if (launchInFlight) return
  launchInFlight = true
  let mayLaunch: boolean

  try {
    mayLaunch = await mayLaunchBee()
  } finally {
    launchInFlight = false
  }

  if (!mayLaunch) return

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
