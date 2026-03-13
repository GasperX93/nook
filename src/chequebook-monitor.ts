import { logger } from './logger'
import { getMode } from './funding-monitor'
import { readConfigYaml } from './config'

const POLL_INTERVAL_MS = 60_000
const REFILL_THRESHOLD_PLUR = '5000000000000000' // 0.5 BZZ in PLUR (1 BZZ = 1e16 PLUR)
const TARGET_DEPOSIT_PLUR = '7000000000000000' // 0.7 BZZ in PLUR
const WALLET_RESERVE_PLUR = BigInt('5000000000000000') // 0.5 BZZ — never go below this

let pollTimer: ReturnType<typeof setInterval> | null = null
let initialFundDone = false

function getBeeUrl(): string {
  return 'http://127.0.0.1:1633'
}

function getAuthHeaders(): Record<string, string> {
  const password = readConfigYaml().password as string | undefined
  return password ? { Authorization: `Bearer ${password}` } : {}
}

async function beeGet<T>(path: string): Promise<T> {
  const res = await fetch(`${getBeeUrl()}${path}`, { headers: getAuthHeaders() })
  if (!res.ok) throw new Error(`Bee ${path}: ${res.status}`)
  return res.json() as Promise<T>
}

async function beePost<T>(path: string): Promise<T> {
  const res = await fetch(`${getBeeUrl()}${path}`, { method: 'POST', headers: getAuthHeaders() })
  if (!res.ok) throw new Error(`Bee ${path}: ${res.status}`)
  return res.json() as Promise<T>
}

interface ChequebookBalance {
  totalBalance: string
  availableBalance: string
}

interface WalletInfo {
  bzzBalance: string
  nativeTokenBalance: string
}

async function checkAndFundChequebook() {
  if (getMode() !== 'light') return

  try {
    const balance = await beeGet<ChequebookBalance>('/chequebook/balance')
    const available = BigInt(balance.availableBalance)
    const threshold = BigInt(REFILL_THRESHOLD_PLUR)

    if (available >= threshold) return

    logger.info(
      `Chequebook balance low (${available} PLUR, threshold ${threshold} PLUR) — attempting refill`,
    )

    const wallet = await beeGet<WalletInfo>('/wallet')
    const walletBzz = BigInt(wallet.bzzBalance)

    if (walletBzz <= WALLET_RESERVE_PLUR) {
      logger.warn(
        `Wallet BZZ too low to fund chequebook (${walletBzz} PLUR, reserve ${WALLET_RESERVE_PLUR} PLUR)`,
      )
      return
    }

    // Deposit up to TARGET, but never drop wallet below reserve
    const target = BigInt(TARGET_DEPOSIT_PLUR)
    const maxDeposit = walletBzz - WALLET_RESERVE_PLUR
    const depositAmount = maxDeposit < target ? maxDeposit : target

    if (depositAmount <= BigInt(0)) return

    logger.info(`Depositing ${depositAmount} PLUR into chequebook`)
    await beePost(`/chequebook/deposit?amount=${depositAmount}`)
    logger.info('Chequebook deposit successful')
  } catch (err) {
    // Non-fatal — retry next interval. Chequebook may not be deployed yet during early startup.
    logger.debug(`Chequebook monitor: ${err}`)
  }
}

/**
 * Start the chequebook monitor. Called after Bee launches.
 * In light mode: does an initial fund attempt after a delay (wait for Bee to deploy chequebook),
 * then polls every 60s.
 */
export function startChequebookMonitor() {
  if (pollTimer) return
  if (getMode() !== 'light') return

  logger.info('Starting chequebook monitor (polling every 60s)')

  // Delay initial check to give Bee time to deploy the chequebook contract
  setTimeout(async () => {
    if (!initialFundDone) {
      await checkAndFundChequebook()
      initialFundDone = true
    }
  }, 30_000)

  pollTimer = setInterval(() => checkAndFundChequebook(), POLL_INTERVAL_MS)
}

/**
 * Called when funding monitor switches from ultra-light to light mode.
 * Bee is restarting — schedule chequebook funding after it's ready.
 */
export function onLightModeSwitch() {
  initialFundDone = false
  stopChequebookMonitor()

  // Give Bee time to start + deploy chequebook, then start monitoring
  setTimeout(() => startChequebookMonitor(), 45_000)
}

export function stopChequebookMonitor() {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
}
