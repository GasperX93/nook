import { providers, utils } from 'ethers'
import { readFileSync } from 'fs'
import { join } from 'path'
import { onLightModeSwitch } from './chequebook-monitor'
import { readConfigYaml, writeConfigYaml } from './config'
import { runLauncher } from './launcher'
import { BeeManager } from './lifecycle'
import { logger } from './logger'
import { checkPath, getPath } from './path'
import { isAutomaticRpc, nookRpcUrl, RPC_RELAY_URL } from './rpc'

export type BeeMode = 'ultra-light' | 'light'

const MIN_XDAI = '0.001'
const POLL_INTERVAL_MS = 15_000

let currentMode: BeeMode = 'light'
let pollTimer: ReturnType<typeof setInterval> | null = null
let monitorAddress: string | undefined

/**
 * What the funding monitor last saw (R5-15). Exposed through /status and
 * `POST /funding/check`, so onboarding can say "found 1.0 xDAI — restarting
 * your node" or "can't reach the network right now" instead of sitting silent.
 */
export interface FundingState {
  /** Epoch ms of the last balance check, null before the first one. */
  checkedAt: number | null
  /** Last xDAI balance read, as a decimal string. */
  xdai: string | null
  /** Why the last check failed (RPC unreachable / throttled), else null. */
  error: string | null
  /** Funds found — Bee is being restarted in light mode. */
  switching: boolean
}

const fundingState: FundingState = { checkedAt: null, xdai: null, error: null, switching: false }

export function getFundingState(): FundingState {
  return { ...fundingState }
}

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

  if (!address) {
    logger.warn('Cannot start funding monitor — missing address')

    return
  }

  logger.info(`Starting funding monitor for 0x${address} (polling every ${POLL_INTERVAL_MS / 1000}s)`)

  monitorAddress = address
  pollTimer = setInterval(async () => checkBalance(address), POLL_INTERVAL_MS)
}

let inFlight: Promise<void> | null = null

/**
 * Run the balance check NOW instead of waiting for the next poll — what
 * onboarding's "I've sent funds — check now" triggers (R5-15). Returns the
 * resulting state. A no-op (just the state) once the node is in light mode.
 */
export async function checkFundingNow(): Promise<FundingState> {
  const address = monitorAddress ?? readAddress()

  if (currentMode === 'light' || fundingState.switching || !address) return getFundingState()

  inFlight ??= checkBalance(address).finally(() => {
    inFlight = null
  })
  await inFlight

  return getFundingState()
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

let lastErrorLog = 0

async function checkBalance(address: string) {
  try {
    // Through the RPC relay (automatic fallback) unless the user set their own.
    const provider = new providers.StaticJsonRpcProvider(nookRpcUrl(), 100)
    const balance = await provider.getBalance(`0x${address}`)
    const threshold = utils.parseEther(MIN_XDAI)

    fundingState.checkedAt = Date.now()
    fundingState.xdai = utils.formatEther(balance)
    fundingState.error = null

    if (balance.gte(threshold)) {
      logger.info(`Funding detected (${utils.formatEther(balance)} xDAI) — switching to light mode`)
      await switchToLightMode()
    }
  } catch (err) {
    // RPC failures are non-fatal — retry next interval — but no longer
    // silent: onboarding shows them, and the log gets one line per 5 min.
    fundingState.checkedAt = Date.now()
    fundingState.error = 'The Gnosis network is not reachable right now'

    if (Date.now() - lastErrorLog > 5 * 60_000) {
      lastErrorLog = Date.now()
      logger.info(`Funding monitor: balance check failed (${(err as Error).message ?? err}) — retrying`)
    }
  }
}

async function switchToLightMode() {
  stopMonitor()
  fundingState.switching = true

  logger.info('Funding detected — stopping Bee, updating config, restarting in light mode')

  // 1. Stop Bee first (per Bee dev guidance)
  BeeManager.stop()
  await BeeManager.waitForSigtermToFinish()

  // 2. Write blockchain-rpc-endpoint and swap-enable AFTER Bee is stopped.
  // Bee gets the RPC relay (automatic fallback) — unless the user already set
  // their own RPC in Settings, which is kept.
  const configured = readConfigYaml()['blockchain-rpc-endpoint']

  writeConfigYaml({
    'blockchain-rpc-endpoint': isAutomaticRpc(configured) ? RPC_RELAY_URL : configured,
    'swap-enable': true,
  })
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
