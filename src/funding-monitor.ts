import { providers, utils } from 'ethers'
import { readFileSync } from 'fs'
import { join } from 'path'
import { readConfigYaml, writeConfigYaml } from './config'
import { runLauncher } from './launcher'
import { BeeManager } from './lifecycle'
import { logger } from './logger'
import { checkPath, getPath } from './path'

export type BeeMode = 'ultra-light' | 'light'

const MIN_XDAI = '0.001'
const POLL_INTERVAL_MS = 15_000

let currentMode: BeeMode = 'light'
let pollTimer: ReturnType<typeof setInterval> | null = null

export function detectMode(): BeeMode {
  if (!checkPath('config.yaml')) return 'ultra-light'
  const config = readConfigYaml()
  const swap = config['swap-enable']

  if (swap === true || swap === 'true') return 'light'

  return 'ultra-light'
}

export function getMode(): BeeMode {
  return currentMode
}

export function startMonitorIfNeeded() {
  currentMode = detectMode()
  logger.info(`Bee mode: ${currentMode}`)

  if (currentMode === 'light') return
  if (pollTimer) return

  const address = readAddress()
  const rpc = readRpc()

  if (!address || !rpc) {
    logger.warn('Cannot start funding monitor — missing address or RPC endpoint')
    return
  }

  logger.info(`Starting funding monitor for 0x${address} (polling every ${POLL_INTERVAL_MS / 1000}s)`)

  pollTimer = setInterval(() => checkBalance(address, rpc), POLL_INTERVAL_MS)
}

function readAddress(): string | undefined {
  try {
    const keyPath = getPath(join('data-dir', 'keys', 'swarm.key'))
    const v3 = JSON.parse(readFileSync(keyPath, 'utf-8'))
    return v3.address as string
  } catch {
    return undefined
  }
}

function readRpc(): string | undefined {
  try {
    const config = readConfigYaml()
    return (config['blockchain-rpc-endpoint'] as string) || undefined
  } catch {
    return undefined
  }
}

async function checkBalance(address: string, rpc: string) {
  try {
    const provider = new providers.JsonRpcProvider(rpc, 100)
    const balance = await provider.getBalance(`0x${address}`)
    const threshold = utils.parseEther(MIN_XDAI)

    if (balance.gte(threshold)) {
      logger.info(`Funding detected (${utils.formatEther(balance)} xDAI) — switching to light mode`)
      await switchToLightMode()
    }
  } catch (err) {
    // RPC failures are non-fatal — retry next interval
    logger.debug(`Funding monitor RPC error: ${err}`)
  }
}

async function switchToLightMode() {
  stopMonitor()

  writeConfigYaml({ 'swap-enable': true })
  currentMode = 'light'

  logger.info('Config updated: swap-enable: true — restarting Bee')

  BeeManager.stop()
  // Wait for Bee process to finish before restarting
  await BeeManager.waitForSigtermToFinish()
  runLauncher().catch(err => logger.error(`Failed to restart Bee: ${err}`))
}

function stopMonitor() {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
}
