import { fetchWithTimeout } from './fetch-timeout'
import { logger } from './logger'
import { dismissNotification, loadNotifications, pushNotification } from './notifications'
import { getMode } from './funding-monitor'
import { readConfigYaml } from './config'

const POLL_INTERVAL_MS = 60_000
const REFILL_THRESHOLD_PLUR = '5000000000000000' // 0.5 BZZ in PLUR (1 BZZ = 1e16 PLUR)
/**
 * Refill targets (user feedback 2026-09-21: refill churn during heavy
 * bandwidth use — the 0.5→0.7 hysteresis re-triggered every ~0.2 xBZZ).
 * Once the identity reserve exists we can afford real headroom (funds stay
 * withdrawable); BEFORE it exists the small legacy target keeps the
 * onboarding promise honest — "about 3 xBZZ" must still cover the reserve.
 */
const TARGET_DEPOSIT_PLUR = '7000000000000000' // 0.7 BZZ — pre-reserve (onboarding)
const TARGET_DEPOSIT_ESTABLISHED_PLUR = '20000000000000000' // 2.0 BZZ — post-reserve
const WALLET_RESERVE_PLUR = BigInt('5000000000000000') // 0.5 BZZ — never go below this

/** Repeat "topped up" bells within a day are churn-noise; the Activity list keeps the full audit trail. */
const NOTIFY_SUPPRESS_MS = 24 * 60 * 60_000

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
  const res = await fetchWithTimeout(`${getBeeUrl()}${path}`, { headers: getAuthHeaders() }, 10_000)

  if (!res.ok) throw new Error(`Bee ${path}: ${res.status}`)

  return res.json() as Promise<T>
}

async function beePost<T>(path: string): Promise<T> {
  const res = await fetchWithTimeout(`${getBeeUrl()}${path}`, { method: 'POST', headers: getAuthHeaders() }, 30_000)

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

    logger.info(`Chequebook balance low (${available} PLUR, threshold ${threshold} PLUR) — attempting refill`)

    const wallet = await beeGet<WalletInfo>('/wallet')
    const walletBzz = BigInt(wallet.bzzBalance)

    if (walletBzz <= WALLET_RESERVE_PLUR) {
      logger.warn(`Wallet BZZ too low to fund chequebook (${walletBzz} PLUR, reserve ${WALLET_RESERVE_PLUR} PLUR)`)

      return
    }

    // Deposit up to TARGET, but never drop wallet below reserve. Headroom
    // only once the identity reserve exists — its ~2 xBZZ purchase must not
    // lose the race for a fresh node's first funds (#130).
    let reserveExists = false

    try {
      const { stamps } = await beeGet<{ stamps?: { label?: string }[] }>('/stamps')

      reserveExists = (stamps ?? []).some(st => st.label === 'nook-system')
    } catch {
      // stamps unreadable — assume pre-reserve, stay conservative
    }
    const target = BigInt(reserveExists ? TARGET_DEPOSIT_ESTABLISHED_PLUR : TARGET_DEPOSIT_PLUR)
    const maxDeposit = walletBzz - WALLET_RESERVE_PLUR
    const depositAmount = maxDeposit < target ? maxDeposit : target

    if (depositAmount <= BigInt(0)) return

    logger.info(`Depositing ${depositAmount} PLUR into chequebook`)
    await beePost(`/chequebook/deposit?amount=${depositAmount}`)
    logger.info('Chequebook deposit successful')
    // Feed-only record (#138): internal rebalancing the bell should remember
    // without interrupting anyone — no desktop notification, and repeats
    // within a day stay out of the bell (the Activity list still shows every
    // deposit via the ledger match).
    const lastFunded = loadNotifications().find(n => n.type === 'chequebook-funded')
    const suppressBell = Boolean(lastFunded && Date.now() - lastFunded.createdAt <= NOTIFY_SUPPRESS_MS)
    const notification = pushNotification({
      type: 'chequebook-funded',
      title: 'Bandwidth chequebook topped up',
      body: `${(Number(depositAmount / BigInt('1000000000000')) / 10_000).toFixed(2)} xBZZ moved from your wallet to the bandwidth chequebook.`,
      data: { amountPlur: depositAmount.toString() },
    })

    // Repeat within a day: keep the record (the Activity ledger reads it for
    // labels) but born-dismissed, so the bell stays quiet.
    if (suppressBell) {
      dismissNotification(notification.id)
      logger.info('Chequebook refill bell suppressed (previous within 24h)')
    }
  } catch (err) {
    // Non-fatal — retry next interval. Chequebook may not be deployed yet
    // during early startup, and Bee returns transient 500s while cheques
    // settle. Log loudly once per streak so silent skips are visible.
    if (!failureLogged) {
      failureLogged = true
      logger.warn(`Chequebook monitor check failed (will keep retrying quietly): ${err}`)
    }

    return
  }
  failureLogged = false
}

let failureLogged = false

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

  pollTimer = setInterval(async () => checkAndFundChequebook(), POLL_INTERVAL_MS)
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
