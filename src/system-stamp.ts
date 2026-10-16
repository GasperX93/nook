import { existsSync, readFileSync, writeFileSync } from 'fs'

import { BATCH_CREATE_GAS_LIMIT } from './blockchain'
import { readConfigYaml } from './config'
import { getAutoExtendSettings, setAutoExtendSetting, topupAmount } from './extend-monitor'
import { fetchWithTimeout } from './fetch-timeout'
import { isOwnBee } from './foreign-bee'
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
 * batch (`nook-system`, depth 18 ≈ 6.66 MB usable — about 800 messages —,
 * immutable, 1 month) and
 * enables auto-renew for it (#129) — the one place auto-extend is
 * near-mandatory. The UI hides it from the Drive list and surfaces it in
 * Settings as "Identity & messages" (never "stamp" in user-facing strings).
 *
 * Existing users need no migration step: the same check sees no system batch
 * on upgrade and buys one as soon as funds allow.
 */

export const SYSTEM_STAMP_LABEL = 'nook-system'

export const SYSTEM_STAMP_DEPTH = 18

export const SYSTEM_STAMP_MONTHS = 1

/**
 * Grow the reserve one depth when its fullest bucket reaches this (an
 * immutable batch refuses writes into a full bucket — for feeds and mailbox
 * slots Bee only answers a generic 400, so fullness is read from /stamps, not
 * from errors). Never past MAX depth: each step doubles the running cost.
 */
export const SYSTEM_STAMP_GROW_RATIO = 0.75

export const SYSTEM_STAMP_MAX_DEPTH = 20

/** Never spend the wallet below this (same floor as the chequebook monitor). */
const WALLET_FLOOR_PLUR = BigInt('5000000000000000') // 0.5 BZZ

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

const STATE_FILE = 'system-stamp.json'

/**
 * The reserve just bought (F-6). Bee can take a while to list a new batch,
 * and until it does the existence check below sees nothing — without this, a
 * wallet that still covers another reserve would buy a second one, and the
 * dashboard fell back to "add about 4 xBZZ" in the meantime.
 */
const JUST_BOUGHT_MS = 30 * 60_000
let justBought: { batchId: string; at: number } | null = null

/** When the reserve was bought, while it may not be listed yet (for /status). */
export function reserveJustBoughtAt(now = Date.now()): number | null {
  return justBought && now - justBought.at < JUST_BOUGHT_MS ? justBought.at : null
}

/** Tests only. */
export function resetJustBoughtForTests(): void {
  justBought = null
}

interface StampState {
  lowFundsNotifiedAt?: number
  /** Depth the "reserve almost full, add funds" notice was last shown for. */
  growBlockedNotifiedDepth?: number
}

function readState(): StampState {
  try {
    return existsSync(getPath(STATE_FILE)) ? (JSON.parse(readFileSync(getPath(STATE_FILE), 'utf-8')) as StampState) : {}
  } catch {
    return {}
  }
}

function writeState(patch: Partial<StampState>): void {
  try {
    writeFileSync(getPath(STATE_FILE), JSON.stringify({ ...readState(), ...patch }))
  } catch {
    // best effort — worst case a notice repeats after a restart
  }
}

function lowFundsAlreadyNotified(): boolean {
  return Boolean(readState().lowFundsNotifiedAt)
}

function notifyLowFundsOnce(): void {
  if (lowFundsAlreadyNotified()) return
  pushNotification({
    type: 'charge-blocked',
    title: 'Add about 4 xBZZ to activate identity & messages',
    body: 'Your node needs about 4 xBZZ to reserve the network space that makes you findable and lets you message. Top up on the Wallet page — Nook does the rest automatically.',
    link: '/account?tab=wallet',
  })
  writeState({ lowFundsNotifiedAt: Date.now() })
}

function clearLowFundsFlag(): void {
  writeState({ lowFundsNotifiedAt: undefined })
}

/** The /stamps fields the reserve checks read. */
export interface ReserveBatch {
  batchID: string
  label?: string
  depth?: number
  bucketDepth?: number
  utilization?: number
  /** Bee ≥ 2.8.1: fullest bucket ÷ slots per bucket. */
  utilizationRatio?: number
  usable?: boolean
}

/** Fullest-bucket fill 0–1 (Bee's ratio, or computed on older nodes). */
export function reserveFillRatio(batch: ReserveBatch): number {
  if (typeof batch.utilizationRatio === 'number') return batch.utilizationRatio
  const slots = 2 ** ((batch.depth ?? 0) - (batch.bucketDepth ?? 16))

  return slots > 0 ? (batch.utilization ?? 0) / slots : 0
}

/**
 * The depth the reserve should grow to, or null to leave it. Reserves bought
 * before 0.7.2 (depth 17 ≈ 44.7 kB — full after ~11 writes) grow to the
 * current depth; any reserve grows one step when its fullest bucket reaches
 * SYSTEM_STAMP_GROW_RATIO, up to SYSTEM_STAMP_MAX_DEPTH.
 */
export function reserveGrowTarget(batch: ReserveBatch): number | null {
  const depth = batch.depth ?? SYSTEM_STAMP_DEPTH

  if (depth < SYSTEM_STAMP_DEPTH) return SYSTEM_STAMP_DEPTH

  if (reserveFillRatio(batch) >= SYSTEM_STAMP_GROW_RATIO && depth < SYSTEM_STAMP_MAX_DEPTH) return depth + 1

  return null
}

/**
 * Grow ("dilute") the reserve in place: same batch, same label, everything
 * already stamped stays valid, each bucket gets twice the room per step.
 * Dilute halves the time left, so it only runs when the wallet also covers the
 * auto-extension that will follow at the new depth, plus the floor — otherwise
 * the reserve would run out two weeks later. Short of that, the user hears it
 * once per depth when the space is filling up.
 */
async function growReserveIfNeeded(batch: ReserveBatch, beeFetch: BeeFetch): Promise<void> {
  const target = reserveGrowTarget(batch)

  if (target === null || !batch.usable) return

  const chainRes = await beeFetch('/chainstate')

  if (!chainRes.ok) return
  const chain = (await chainRes.json()) as { chainTip?: number; block?: number; currentPrice?: string }

  if (
    typeof chain.chainTip !== 'number' ||
    typeof chain.block !== 'number' ||
    chain.chainTip - chain.block >= TRUSTED_CHAIN_LAG_BLOCKS ||
    !chain.currentPrice
  ) {
    return
  }

  const setting = getAutoExtendSettings()[batch.batchID.toLowerCase()]
  const nextExtendCost = topupAmount(SYSTEM_STAMP_MONTHS, chain.currentPrice) << BigInt(target)

  const walletRes = await beeFetch('/wallet')

  if (!walletRes.ok) return
  const bzzBalance = BigInt(((await walletRes.json()) as { bzzBalance: string }).bzzBalance)

  if (bzzBalance < nextExtendCost + WALLET_FLOOR_PLUR) {
    if (reserveFillRatio(batch) >= SYSTEM_STAMP_GROW_RATIO && readState().growBlockedNotifiedDepth !== target) {
      const needed = Number((nextExtendCost + WALLET_FLOOR_PLUR) / BigInt(1e14)) / 100
      pushNotification({
        type: 'charge-blocked',
        title: 'The space for your identity & messages is filling up',
        body: `Nook needs about ${Math.ceil(needed)} xBZZ in your wallet to make it bigger. Until then, sending messages may fail. Top up on the Wallet page.`,
        link: '/account?tab=wallet',
      })
      writeState({ growBlockedNotifiedDepth: target })
    }

    return
  }

  // R5-11: never spend with a node that isn't provably Nook's own.
  if (!(await isOwnBee())) {
    logger.error('system-stamp: grow skipped — the node on port 1633 is not Nook’s own')

    return
  }

  const res = await beeFetch(`/stamps/dilute/${batch.batchID}/${target}`, { method: 'PATCH' }, 300_000)

  if (!res.ok) {
    logger.error(`system-stamp: grow to depth ${target} failed (${res.status})`)

    return
  }

  // Nook manages the reserve's extension length; keep the user's on/off choice.
  setAutoExtendSetting(batch.batchID, setting?.enabled ?? true, SYSTEM_STAMP_MONTHS)
  writeState({ growBlockedNotifiedDepth: undefined })
  pushNotification({
    type: 'info',
    title: 'More space for your identity & messages',
    body: 'Nook made the reserved space bigger so your messages keep going through. It extends automatically — manage it in Settings.',
    link: '/settings',
  })
  logger.info(`system-stamp: grew ${batch.batchID.slice(0, 8)} from depth ${batch.depth} to ${target}`)
}

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
    const { stamps } = (await stampsRes.json()) as { stamps?: ReserveBatch[] }
    const reserve = (stamps ?? []).find(s => s.label === SYSTEM_STAMP_LABEL)

    if (reserve) {
      await growReserveIfNeeded(reserve, beeFetch)

      return 'exists'
    }

    // Bought moments ago but not listed yet — never buy twice.
    if (reserveJustBoughtAt() !== null) return 'exists'

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

    if (bzzBalance < totalCost) {
      // The user funded SOMETHING but not enough for the reserve — without a
      // word, identity and messaging silently never activate and the user has
      // no way to know why (fresh-install finding, 2026-09-17). Tell them once.
      if (bzzBalance > BigInt(0)) notifyLowFundsOnce()

      return 'skipped'
    }

    // R5-11: never buy with a node that isn't provably Nook's own.
    if (!(await isOwnBee())) {
      logger.error('system-stamp: purchase skipped — the node on port 1633 is not Nook’s own')

      return 'skipped'
    }

    // Chain transaction — generous timeout, mined before Bee responds.
    const buyRes = await beeFetch(
      `/stamps/${amountPerChunk.toString()}/${SYSTEM_STAMP_DEPTH}?label=${SYSTEM_STAMP_LABEL}`,
      { method: 'POST', headers: { immutable: 'true', 'Gas-Limit': BATCH_CREATE_GAS_LIMIT } },
      300_000,
    )

    if (!buyRes.ok) {
      logger.error(`system-stamp: buy failed (${buyRes.status})`)

      return 'failed'
    }
    const { batchID } = (await buyRes.json()) as { batchID: string }

    justBought = { batchId: batchID, at: Date.now() }

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
      body: 'Nook set aside a small network space so you can be found and message reliably. It extends automatically — manage it in Settings.',
      link: '/settings',
    })
    logger.info(`system-stamp: bought ${batchID.slice(0, 8)} (depth ${SYSTEM_STAMP_DEPTH}, ${SYSTEM_STAMP_MONTHS}mo)`)
    clearLowFundsFlag()

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
