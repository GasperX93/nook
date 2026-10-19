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
 * on upgrade and buys one as soon as funds allow. A reserve that is old
 * (depth 17, before 0.7.2) or full is replaced the same way — see
 * RETIRED_SYSTEM_STAMP_LABEL for why it is never grown in place.
 */

export const SYSTEM_STAMP_LABEL = 'nook-system'

export const SYSTEM_STAMP_DEPTH = 18

export const SYSTEM_STAMP_MONTHS = 1

/**
 * The retired label. A reserve that can no longer take writes is replaced by
 * a new one, never grown in place: Bee 2.8.3 keeps a depth increase only in
 * memory until the next write to the batch, so a restart in between brings
 * back the old depth in Bee's view for good (pkg/postage/service.go
 * HandleDepthIncrease never marks the issuer dirty). A label update is saved
 * at once, so the old reserve is renamed, hidden and no longer extended; it
 * runs out on its own.
 */
export const RETIRED_SYSTEM_STAMP_LABEL = 'nook-system-retired'

/** Never spend the wallet below this (same floor as the chequebook monitor). */
const WALLET_FLOOR_PLUR = BigInt('5000000000000000') // 0.5 BZZ

const CHECK_INTERVAL_MS = 60_000

/** First check once Bee has had time to come up and (maybe) sync postage. */
const INITIAL_DELAY_MS = 2 * 60_000

/** A batchstore answer is only trusted while the chain view is near the tip. */
const TRUSTED_CHAIN_LAG_BLOCKS = 120

/**
 * A purchase just sent or just made. Bee can take a while to list a new
 * batch; until it does nothing is bought again. Kept in the state file, so a
 * restart in the middle of a purchase can't buy twice.
 */
const BUY_SETTLE_MS = 30 * 60_000

/** After a failed purchase, wait this long before the next try. */
const BUY_RETRY_MS = 60 * 60_000

/** Failed purchases in a row before Nook stops trying (until the next start). */
const MAX_BUY_FAILURES = 3

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

interface StampState {
  lowFundsNotifiedAt?: number
  /** Set just before a purchase is sent, cleared when it answers. */
  buySentAt?: number
  /** The last reserve bought, and when. */
  boughtBatchId?: string
  boughtAt?: number
  buyFailures?: number
  lastBuyFailureAt?: number
  buyStoppedNotified?: boolean
  /** The full/old reserve the "add funds to replace it" notice was shown for. */
  replaceBlockedNotifiedFor?: string
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

/** When the reserve was bought, while it may not be listed yet (for /status). */
export function reserveJustBoughtAt(now = Date.now()): number | null {
  const { boughtAt } = readState()

  return boughtAt && now - boughtAt < BUY_SETTLE_MS ? boughtAt : null
}

function buySettling(now = Date.now()): boolean {
  const { buySentAt } = readState()

  return reserveJustBoughtAt(now) !== null || Boolean(buySentAt && now - buySentAt < BUY_SETTLE_MS)
}

function notifyLowFundsOnce(): void {
  if (readState().lowFundsNotifiedAt) return
  pushNotification({
    type: 'charge-blocked',
    title: 'Add about 4 xBZZ to activate identity & messages',
    body: 'Your node needs about 4 xBZZ to reserve the network space that makes you findable and lets you message. Top up on the Wallet page — Nook does the rest automatically.',
    link: '/account?tab=wallet',
  })
  writeState({ lowFundsNotifiedAt: Date.now() })
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
 * Whether a reserve can keep taking writes, as Bee itself sees it (Bee stamps
 * from its own copy, so /stamps is the view that counts). Reserves bought
 * before 0.7.2 are depth 17 (≈ 44.7 kB, full after ~11 writes) and are
 * replaced; so is a full one — Bee refuses writes into a full bucket with a
 * generic 400.
 */
export function reserveNeedsReplacing(batch: ReserveBatch): boolean {
  return (batch.depth ?? SYSTEM_STAMP_DEPTH) < SYSTEM_STAMP_DEPTH || reserveFillRatio(batch) >= 1
}

/**
 * Rename an old reserve and stop extending it. No money moves — safe to
 * repeat on every pass until it works.
 */
async function retireReserve(batch: ReserveBatch, beeFetch: BeeFetch): Promise<void> {
  const res = await beeFetch(`/stamps/${batch.batchID}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ label: RETIRED_SYSTEM_STAMP_LABEL }),
  })

  if (!res.ok) {
    logger.error(`system-stamp: retiring ${batch.batchID.slice(0, 8)} failed (${res.status}) — will retry`)

    return
  }
  const setting = getAutoExtendSettings()[batch.batchID.toLowerCase()]

  setAutoExtendSetting(batch.batchID, false, setting?.months ?? SYSTEM_STAMP_MONTHS)
  logger.info(`system-stamp: retired ${batch.batchID.slice(0, 8)} (depth ${batch.depth}) — no longer extended`)
}

export type SystemStampResult = 'exists' | 'bought' | 'skipped' | 'failed'

/**
 * One pass. Keeps exactly one working reserve at SYSTEM_STAMP_DEPTH: buys one
 * when there is none, or when the current one is old or full (then retires
 * the old one). Silent skips are the normal state — funding simply hasn't
 * arrived yet.
 */
export async function runSystemStampCheck(beeFetch: BeeFetch = realBeeFetch): Promise<SystemStampResult> {
  if (getMode() !== 'light') return 'skipped'

  if (inFlight) return 'skipped'
  inFlight = true
  try {
    const stampsRes = await beeFetch('/stamps')

    if (!stampsRes.ok) return 'skipped'
    const { stamps } = (await stampsRes.json()) as { stamps?: ReserveBatch[] }
    const labelled = (stamps ?? []).filter(s => s.label === SYSTEM_STAMP_LABEL)
    const working = labelled.filter(s => !reserveNeedsReplacing(s))
    const state = readState()

    if (working.length > 0) {
      // One working reserve: the last one bought when it's listed, else the
      // newest-looking one. Any other labelled batch is retired.
      const keep = working.find(s => s.batchID === state.boughtBatchId) ?? working[working.length - 1]

      for (const old of labelled) {
        if (old.batchID !== keep.batchID) await retireReserve(old, beeFetch)
      }

      return 'exists'
    }

    // Bought (or being bought) moments ago but not listed yet — never buy twice.
    if (buySettling()) return 'exists'

    const failures = state.buyFailures ?? 0

    if (failures >= MAX_BUY_FAILURES) return 'skipped'

    if (failures > 0 && state.lastBuyFailureAt && Date.now() - state.lastBuyFailureAt < BUY_RETRY_MS) return 'skipped'

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
    // A replacement keeps the wallet floor; a first reserve may use it all
    // (the onboarding amount is sized for exactly that).
    const replacing = labelled[0]
    const needed = replacing ? totalCost + WALLET_FLOOR_PLUR : totalCost

    const walletRes = await beeFetch('/wallet')

    if (!walletRes.ok) return 'skipped'
    const bzzBalance = BigInt(((await walletRes.json()) as { bzzBalance: string }).bzzBalance)

    if (bzzBalance < needed) {
      if (replacing) {
        if (state.replaceBlockedNotifiedFor !== replacing.batchID) {
          pushNotification({
            type: 'charge-blocked',
            title: 'The space for your identity & messages is full',
            body: `Nook needs about ${Math.ceil(Number(needed / BigInt(1e14)) / 100)} xBZZ in your wallet to set up new space. Until then, messages use space from your drives. Top up on the Wallet page.`,
            link: '/account?tab=wallet',
          })
          writeState({ replaceBlockedNotifiedFor: replacing.batchID })
        }
      } else if (bzzBalance > BigInt(0)) {
        // The user funded SOMETHING but not enough for the reserve — without a
        // word, identity and messaging silently never activate (fresh-install
        // finding, 2026-09-17). Tell them once.
        notifyLowFundsOnce()
      }

      return 'skipped'
    }

    // R5-11: never buy with a node that isn't provably Nook's own.
    if (!(await isOwnBee())) {
      logger.error('system-stamp: purchase skipped — the node on port 1633 is not Nook’s own')

      return 'skipped'
    }

    // Written down BEFORE sending: a restart mid-purchase must not buy again.
    writeState({ buySentAt: Date.now() })

    // Chain transaction — generous timeout, mined before Bee responds.
    const buyRes = await beeFetch(
      `/stamps/${amountPerChunk.toString()}/${SYSTEM_STAMP_DEPTH}?label=${SYSTEM_STAMP_LABEL}`,
      { method: 'POST', headers: { immutable: 'true', 'Gas-Limit': BATCH_CREATE_GAS_LIMIT } },
      300_000,
    )

    if (!buyRes.ok) {
      const buyFailures = failures + 1

      logger.error(`system-stamp: buy failed (${buyRes.status}) — attempt ${buyFailures} of ${MAX_BUY_FAILURES}`)
      writeState({ buySentAt: undefined, buyFailures, lastBuyFailureAt: Date.now() })

      if (buyFailures >= MAX_BUY_FAILURES && !state.buyStoppedNotified) {
        pushNotification({
          type: 'charge-blocked',
          title: 'Couldn’t set up space for your identity & messages',
          body: 'Nook tried 3 times and stopped. Messages use space from your drives meanwhile. Restart Nook to try again.',
          link: '/settings',
        })
        writeState({ buyStoppedNotified: true })
      }

      return 'failed'
    }
    const { batchID } = (await buyRes.json()) as { batchID: string }

    writeState({
      buySentAt: undefined,
      boughtBatchId: batchID,
      boughtAt: Date.now(),
      buyFailures: 0,
      lastBuyFailureAt: undefined,
      buyStoppedNotified: undefined,
      lowFundsNotifiedAt: undefined,
      replaceBlockedNotifiedFor: undefined,
    })

    // Auto-renew ON by default — this space expiring means unreachable
    // identity and lost unsent messages; opting out lives in Settings. A
    // replacement keeps the user's on/off choice.
    const previous = replacing ? getAutoExtendSettings()[replacing.batchID.toLowerCase()] : undefined

    setAutoExtendSetting(batchID, previous?.enabled ?? true, SYSTEM_STAMP_MONTHS)
    recordPurchase({
      kind: 'create',
      batchId: batchID,
      label: SYSTEM_STAMP_LABEL,
      amountPlur: purchaseCostPlur(amountPerChunk.toString(), SYSTEM_STAMP_DEPTH),
    })

    for (const old of labelled) await retireReserve(old, beeFetch)

    pushNotification(
      replacing
        ? {
            type: 'info',
            title: 'New space for your identity & messages',
            body: 'The previous space was full, so Nook set up a new one. The old one is no longer extended and runs out on its own.',
            link: '/settings',
          }
        : {
            type: 'info',
            title: 'Reserved space for your identity & messages',
            body: 'Nook set aside a small network space so you can be found and message reliably. It extends automatically — manage it in Settings.',
            link: '/settings',
          },
    )
    logger.info(
      `system-stamp: bought ${batchID.slice(0, 8)} (depth ${SYSTEM_STAMP_DEPTH}, ${SYSTEM_STAMP_MONTHS}mo)${
        replacing ? ` to replace ${replacing.batchID.slice(0, 8)}` : ''
      }`,
    )

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
  // A restart is the user's way to try a stopped purchase again.
  writeState({ buyFailures: undefined, lastBuyFailureAt: undefined, buyStoppedNotified: undefined })
  setTimeout(() => {
    void runSystemStampCheck()
    setInterval(async () => runSystemStampCheck(), CHECK_INTERVAL_MS)
  }, INITIAL_DELAY_MS)
  logger.info('system-stamp monitor started (#130)')
}
