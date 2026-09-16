import { readConfigYaml } from './config'
import { setAutoExtendSetting, topupAmount } from './extend-monitor'
import { fetchWithTimeout } from './fetch-timeout'
import { getMode } from './funding-monitor'
import { logger } from './logger'
import { pushNotification } from './notifications'
import { getPath } from './path'
import { purchaseCostPlur, recordPurchase } from './purchases'

/**
 * System stamp (#130) — the reserved network space for identity & messages.
 *
 * Identity publishing and message sends used to hijack the first usable drive
 * batch: a hard dead-end with no drives, and a coupling of messaging to a
 * random drive's lifetime with them. Instead, once the node is in light mode
 * with a synced chain and enough xBZZ, the server buys ONE small labeled
 * batch (`nook-system`, depth 17 ≈ 7 MB effective, immutable, 3 months) and
 * enables auto-renew for it (#129) — the one place auto-extend is
 * near-mandatory. The UI hides it from the Drive list and surfaces it in
 * Settings as "Identity & messages" (never "stamp" in user-facing strings).
 *
 * Existing users need no migration step: the same check sees no system batch
 * on upgrade and buys one as soon as funds allow.
 */

export const SYSTEM_STAMP_LABEL = 'nook-system'

export const SYSTEM_STAMP_DEPTH = 17

export const SYSTEM_STAMP_MONTHS = 3

const CHECK_INTERVAL_MS = 60_000

/** First check once Bee has had time to come up and (maybe) sync postage. */
const INITIAL_DELAY_MS = 2 * 60_000

/** A batchstore answer is only trusted while the chain view is near the tip. */
const TRUSTED_CHAIN_LAG_BLOCKS = 120

export type BeeFetch = (path: string, init?: RequestInit, timeoutMs?: number) => Promise<Response>

function getAuthHeaders(): Record<string, string> {
  const password = readConfigYaml().password as string | undefined

  return password ? { Authorization: `Bearer ${password}` } : {}
}

const realBeeFetch: BeeFetch = async (path, init, timeoutMs = 15_000) =>
  fetchWithTimeout(
    `http://127.0.0.1:1633${path}`,
    { ...init, headers: { ...getAuthHeaders(), ...init?.headers } },
    timeoutMs,
  )

let inFlight = false

export type SystemStampResult = 'exists' | 'bought' | 'skipped' | 'failed'

/**
 * One pass: buy the system batch if (and only if) every condition holds.
 * Silent skips are the normal state — funding simply hasn't arrived yet.
 */
export async function runSystemStampCheck(beeFetch: BeeFetch = realBeeFetch): Promise<SystemStampResult> {
  if (getMode() !== 'light') return 'skipped'

  if (inFlight) return 'skipped'
  inFlight = true
  try {
    // Existence first — one system batch, ever, while it lives. Any batch
    // carrying the label counts (usable or not): auto-renew keeps it alive,
    // and rebuying beside a hiccuping one would double-spend.
    const stampsRes = await beeFetch('/stamps')

    if (!stampsRes.ok) return 'skipped'
    const { stamps } = (await stampsRes.json()) as { stamps?: { batchID: string; label?: string }[] }

    if ((stamps ?? []).some(s => s.label === SYSTEM_STAMP_LABEL)) return 'exists'

    // Never act on a lagging chain view — price and wallet would be stale.
    const chainRes = await beeFetch('/chainstate')

    if (!chainRes.ok) return 'skipped'
    const chain = (await chainRes.json()) as { chainTip?: number; block?: number; currentPrice?: string }

    if (
      typeof chain.chainTip !== 'number' ||
      typeof chain.block !== 'number' ||
      chain.chainTip - chain.block >= TRUSTED_CHAIN_LAG_BLOCKS ||
      !chain.currentPrice
    ) {
      return 'skipped'
    }

    const amountPerChunk = topupAmount(SYSTEM_STAMP_MONTHS, chain.currentPrice)
    const totalCost = amountPerChunk << BigInt(SYSTEM_STAMP_DEPTH)

    const walletRes = await beeFetch('/wallet')

    if (!walletRes.ok) return 'skipped'
    const bzzBalance = BigInt(((await walletRes.json()) as { bzzBalance: string }).bzzBalance)

    if (bzzBalance < totalCost) return 'skipped'

    // Chain transaction — generous timeout, mined before Bee responds.
    const buyRes = await beeFetch(
      `/stamps/${amountPerChunk.toString()}/${SYSTEM_STAMP_DEPTH}?label=${SYSTEM_STAMP_LABEL}`,
      { method: 'POST', headers: { immutable: 'true' } },
      300_000,
    )

    if (!buyRes.ok) {
      logger.error(`system-stamp: buy failed (${buyRes.status})`)

      return 'failed'
    }
    const { batchID } = (await buyRes.json()) as { batchID: string }

    // Auto-renew ON by default — this space expiring means unreachable
    // identity and lost unsent messages; opting out lives in Settings.
    setAutoExtendSetting(batchID, true, SYSTEM_STAMP_MONTHS)
    recordPurchase({
      kind: 'create',
      batchId: batchID,
      label: SYSTEM_STAMP_LABEL,
      amountPlur: purchaseCostPlur(amountPerChunk.toString(), SYSTEM_STAMP_DEPTH),
    })
    pushNotification({
      type: 'info',
      title: 'Reserved space for your identity & messages',
      body: 'Nook set aside a small network space so you can be found and message reliably. It renews automatically — manage it in Settings.',
      link: '/settings',
    })
    logger.info(`system-stamp: bought ${batchID.slice(0, 8)} (depth ${SYSTEM_STAMP_DEPTH}, ${SYSTEM_STAMP_MONTHS}mo)`)

    return 'bought'
  } catch (error) {
    logger.info(`system-stamp: check failed (${error}) — will retry`)

    return 'failed'
  } finally {
    inFlight = false
  }
}

export function startSystemStampMonitor(): void {
  // getPath forces the data dir to exist before any dependent write.
  void getPath('')
  setTimeout(() => {
    void runSystemStampCheck()
    setInterval(async () => runSystemStampCheck(), CHECK_INTERVAL_MS)
  }, INITIAL_DELAY_MS)
  logger.info('system-stamp monitor started (#130)')
}
