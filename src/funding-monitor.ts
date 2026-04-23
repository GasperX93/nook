import { providers, utils } from 'ethers'
import { readFileSync } from 'fs'
import { join } from 'path'
import { onLightModeSwitch } from './chequebook-monitor'
import { readConfigYaml, writeConfigYaml } from './config'
import { runLauncher } from './launcher'
import { BeeManager } from './lifecycle'
import { logger } from './logger'
import { checkPath, getPath } from './path'

export type BeeMode = 'ultra-light' | 'light'

const MIN_XDAI = '0.001'
const POLL_INTERVAL_MS = 15_000
const RPC_ENDPOINT = 'https://rpc.gnosischain.com'

let currentMode: BeeMode = 'light'
let pollTimer: ReturnType<typeof setInterval> | null = null
let needsFunding = false

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

export function getNeedsFunding(): boolean {
  return needsFunding
}

export function startMonitorIfNeeded() {
  currentMode = detectMode()
  logger.info(`Bee mode: ${currentMode}`)

  if (pollTimer) return

  const address = readAddress()

  if (!address) {
    logger.warn('Cannot start funding monitor — missing address')

    return
  }

  logger.info(`Starting funding monitor for 0x${address} (polling every ${POLL_INTERVAL_MS / 1000}s)`)

  pollTimer = setInterval(async () => checkBalance(address, RPC_ENDPOINT), POLL_INTERVAL_MS)
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

async function checkBalance(address: string, rpc: string) {
  try {
    const provider = new providers.JsonRpcProvider(rpc, 100)
    const balance = await provider.getBalance(`0x${address}`)
    const threshold = utils.parseEther(MIN_XDAI)
    const funded = balance.gte(threshold)

    if (currentMode === 'ultra-light' && funded) {
      logger.info(`Funding detected (${utils.formatEther(balance)} xDAI) — switching to light mode`)
      needsFunding = false
      await switchToLightMode()
    } else if (currentMode === 'light') {
      const wasMissing = needsFunding
      needsFunding = !funded

      if (needsFunding && !wasMissing) {
        logger.warn(`Wallet 0x${address} has insufficient xDAI — node needs funding to deploy chequebook`)
      } else if (!needsFunding && wasMissing) {
        logger.info(`Funding detected (${utils.formatEther(balance)} xDAI) — wallet is now funded`)
      }
    }
  } catch (err) {
    // RPC failures are non-fatal — retry next interval
    logger.debug(`Funding monitor RPC error: ${err}`)
  }
}

async function switchToLightMode() {
  stopMonitor()

  logger.info('Funding detected — stopping Bee, updating config, restarting in light mode')

  // 1. Stop Bee first (per Bee dev guidance)
  BeeManager.stop()
  await BeeManager.waitForSigtermToFinish()

  // 2. Write blockchain-rpc-endpoint and swap-enable AFTER Bee is stopped
  writeConfigYaml({ 'blockchain-rpc-endpoint': RPC_ENDPOINT, 'swap-enable': true })
  currentMode = 'light'

  // 3. Start Bee in light mode
  runLauncher().catch(err => logger.error(`Failed to restart Bee: ${err}`))

  // 4. Schedule chequebook funding after Bee is ready
  onLightModeSwitch()
}

function stopMonitor() {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
}
