import { existsSync, readFileSync, writeFileSync } from 'fs'

import { readConfigYaml } from './config'
import { fetchWithTimeout } from './fetch-timeout'
import { logger } from './logger'
import { getPath } from './path'

/**
 * Auto-extend monitor (#129) — keeps opted-in drives alive by topping up
 * their batches before expiry, from the node wallet, without the user
 * remembering to.
 *
 * A drive that silently expires is data loss on a timer; this monitor turns
 * keeping a drive alive into a one-time decision. Sibling of the funding and
 * chequebook monitors: server-side, so it works with the dashboard closed
 * (Nook itself must be running — there is no push channel to a closed app).
 *
 * Decision: enabled drive AND live batchTTL < threshold (10 days) → topup by
 * the drive's chosen duration, via the SAME Bee call the manual Extend uses
 * (`PATCH /stamps/topup/:id/:amount`). Topup is a chain operation, not a
 * stamped chunk write — the reclaimable poison guards do not (and must not)
 * apply, so both drive types are supported.
 *
 * Honesty: failures are recorded per drive and surfaced through /status —
 * the UI turns them into a loud banner, because silence here is a countdown.
 */

export interface AutoExtendEntry {
  enabled: boolean
  /** Duration to add per extension — same options as the manual Extend flow. */
  months: number
  /** Unix ms of the last successful auto-extension. */
  lastExtendedAt?: number
  /** Present while the last attempt failed; cleared on success. */
  lastFailure?: { at: number; reason: string }
}

export interface AutoExtendFailure {
  batchId: string
  ttlDays: number | null
  reason: string
  at: number
}

const SETTINGS_FILE = 'auto-extend.json'

const DAY_SECONDS = 86_400
/** Extend when live TTL drops below this. Env override for live testing. */
export const THRESHOLD_SECONDS = (Number(process.env.NOOK_AUTOEXTEND_THRESHOLD_DAYS) || 10) * DAY_SECONDS

const CHECK_INTERVAL_MS = 6 * 60 * 60_000
/** While any failure persists, retry hourly — TTL keeps falling. */
const FAILURE_RETRY_MS = 60 * 60_000
/** First check shortly after startup, once Bee has had time to come up. */
const INITIAL_DELAY_MS = 3 * 60_000

const SECONDS_PER_BLOCK = 5 // Gnosis
const BLOCKS_PER_MONTH = BigInt((30 * DAY_SECONDS) / SECONDS_PER_BLOCK)
/** A batchstore answer is only trusted while the chain view is near the tip. */
const TRUSTED_CHAIN_LAG_BLOCKS = 120

function settingsPath(): string {
  return getPath(SETTINGS_FILE)
}

export function getAutoExtendSettings(): Record<string, AutoExtendEntry> {
  try {
    if (!existsSync(settingsPath())) return {}
    const data = JSON.parse(readFileSync(settingsPath(), 'utf-8')) as Record<string, AutoExtendEntry>

    return data && typeof data === 'object' && !Array.isArray(data) ? data : {}
  } catch (error) {
    logger.error(`auto-extend settings unreadable: ${error}`)

    return {}
  }
}

function saveSettings(settings: Record<string, AutoExtendEntry>): void {
  writeFileSync(settingsPath(), JSON.stringify(settings, null, 2))
}

export function setAutoExtendSetting(batchId: string, enabled: boolean, months: number): AutoExtendEntry {
  const id = batchId.toLowerCase()

  if (!/^[0-9a-f]{64}$/.test(id)) throw new Error(`Invalid batch ID: ${batchId}`)

  if (!Number.isInteger(months) || months < 1 || months > 24) throw new Error(`Invalid duration: ${months} months`)
  const settings = getAutoExtendSettings()
  const entry: AutoExtendEntry = { ...settings[id], enabled, months }

  // A fresh decision clears stale failure state either way: disabled drives
  // shouldn't warn, and re-enabling deserves a clean retry.
  delete entry.lastFailure
  settings[id] = entry
  saveSettings(settings)

  return entry
}

/** Failures for /status — the UI banner keys on these. */
export function getAutoExtendFailures(): AutoExtendFailure[] {
  const failures: AutoExtendFailure[] = []

  for (const [batchId, entry] of Object.entries(getAutoExtendSettings())) {
    if (entry.enabled && entry.lastFailure) {
      failures.push({ batchId, ttlDays: null, reason: entry.lastFailure.reason, at: entry.lastFailure.at })
    }
  }

  return failures
}

// ─── Bee access (same auth pattern as chequebook-monitor) ────────────────────

function getBeeUrl(): string {
  return 'http://127.0.0.1:1633'
}

function getAuthHeaders(): Record<string, string> {
  const password = readConfigYaml().password as string | undefined

  return password ? { Authorization: `Bearer ${password}` } : {}
}

/** Injectable for tests — never hit a real Bee from jest. */
export type BeeFetch = (path: string, init?: { method?: string }, timeoutMs?: number) => Promise<Response>

const realBeeFetch: BeeFetch = async (path, init, timeoutMs = 15_000) =>
  fetchWithTimeout(`${getBeeUrl()}${path}`, { ...init, headers: getAuthHeaders() }, timeoutMs)

// ─── Decision logic (pure, tested) ───────────────────────────────────────────

export function shouldExtend(
  entry: AutoExtendEntry,
  ttlSeconds: number,
  thresholdSeconds = THRESHOLD_SECONDS,
): boolean {
  return entry.enabled && ttlSeconds > 0 && ttlSeconds < thresholdSeconds
}

/** amount per chunk for `months` at `currentPrice` — same math as manual Extend. */
export function topupAmount(months: number, currentPrice: string): bigint {
  return BigInt(currentPrice) * BLOCKS_PER_MONTH * BigInt(months)
}

// ─── The check ───────────────────────────────────────────────────────────────

const inFlight = new Set<string>()

/**
 * One pass over all enabled drives. Returns true when any failure is
 * outstanding (the scheduler switches to hourly retries).
 */
export async function runExtendCheck(beeFetch: BeeFetch = realBeeFetch): Promise<boolean> {
  const settings = getAutoExtendSettings()
  const enabled = Object.entries(settings).filter(([, e]) => e.enabled)

  if (enabled.length === 0) return false

  // Never act on a lagging chain view — TTLs and prices would be stale, and
  // a 404 from the batchstore could be sync-incompleteness, not expiry.
  let currentPrice: string

  try {
    const chainRes = await beeFetch('/chainstate')

    if (!chainRes.ok) throw new Error(`chainstate ${chainRes.status}`)
    const chain = (await chainRes.json()) as { chainTip?: number; block?: number; currentPrice?: string }

    if (
      typeof chain.chainTip !== 'number' ||
      typeof chain.block !== 'number' ||
      chain.chainTip - chain.block >= TRUSTED_CHAIN_LAG_BLOCKS ||
      !chain.currentPrice
    ) {
      logger.info('auto-extend: chain view lagging or incomplete — skipping this pass')

      return getAutoExtendFailures().length > 0
    }
    currentPrice = chain.currentPrice
  } catch (error) {
    logger.info(`auto-extend: Bee unavailable (${error}) — skipping this pass`)

    return getAutoExtendFailures().length > 0
  }

  let bzzBalance: bigint

  try {
    const walletRes = await beeFetch('/wallet')

    if (!walletRes.ok) throw new Error(`wallet ${walletRes.status}`)
    bzzBalance = BigInt(((await walletRes.json()) as { bzzBalance: string }).bzzBalance)
  } catch (error) {
    logger.info(`auto-extend: wallet unreadable (${error}) — skipping this pass`)

    return getAutoExtendFailures().length > 0
  }

  for (const [batchId, entry] of enabled) {
    if (inFlight.has(batchId)) continue
    inFlight.add(batchId)
    try {
      await checkOneBatch(beeFetch, batchId, entry, currentPrice, bzzBalance)
    } finally {
      inFlight.delete(batchId)
    }
  }

  return getAutoExtendFailures().length > 0
}

function recordFailure(batchId: string, reason: string): void {
  const settings = getAutoExtendSettings()
  const entry = settings[batchId]

  if (!entry) return
  entry.lastFailure = { at: Date.now(), reason }
  settings[batchId] = entry
  saveSettings(settings)
  logger.error(`auto-extend failed for ${batchId.slice(0, 8)}: ${reason}`)
}

function recordSuccess(batchId: string): void {
  const settings = getAutoExtendSettings()
  const entry = settings[batchId]

  if (!entry) return
  entry.lastExtendedAt = Date.now()
  delete entry.lastFailure
  settings[batchId] = entry
  saveSettings(settings)
}

async function readTtl(beeFetch: BeeFetch, batchId: string): Promise<{ ttl: number; depth: number } | 'gone' | null> {
  const res = await beeFetch(`/batches/${batchId}`)

  if (res.status === 404) return 'gone'

  if (!res.ok) return null
  const body = (await res.json()) as { batchTTL?: number; depth?: number }

  return typeof body.batchTTL === 'number' && typeof body.depth === 'number'
    ? { ttl: body.batchTTL, depth: body.depth }
    : null
}

async function checkOneBatch(
  beeFetch: BeeFetch,
  batchId: string,
  entry: AutoExtendEntry,
  currentPrice: string,
  bzzBalance: bigint,
): Promise<void> {
  try {
    const batch = await readTtl(beeFetch, batchId)

    if (batch === 'gone') {
      // Chain is synced (checked above), so a 404 is real expiry — nothing to
      // extend anymore. Record once; the UI shows the drive's own tombstone.
      recordFailure(batchId, 'The drive has already expired — it can no longer be extended')

      return
    }

    if (batch === null) {
      recordFailure(batchId, 'Could not read the drive from the node')

      return
    }

    if (!shouldExtend(entry, batch.ttl)) {
      // Healthy — make sure no stale failure keeps a banner alive.
      if (entry.lastFailure) recordSuccessLikeClear(batchId)

      return
    }

    const amount = topupAmount(entry.months, currentPrice)
    const totalCost = amount << BigInt(batch.depth)

    if (totalCost > bzzBalance) {
      // PLUR → xBZZ with 4 decimals, avoiding BigInt literals (ES5 target)
      const needed = Number(totalCost / BigInt('1000000000000')) / 10_000

      recordFailure(batchId, `Not enough xBZZ (needs ~${needed.toFixed(2)} xBZZ)`)

      return
    }

    // Re-read right before paying — a manual extend may have just landed, and
    // a double topup would silently double-spend.
    const fresh = await readTtl(beeFetch, batchId)

    if (fresh === 'gone' || fresh === null || !shouldExtend(entry, fresh.ttl)) return

    // Chain transaction — generous timeout, mined before Bee responds.
    const topup = await beeFetch(`/stamps/topup/${batchId}/${amount.toString()}`, { method: 'PATCH' }, 180_000)

    if (!topup.ok) {
      recordFailure(batchId, `Extension transaction failed (${topup.status})`)

      return
    }
    recordSuccess(batchId)
    logger.info(
      `auto-extend: extended ${batchId.slice(0, 8)} by ${entry.months} month(s) (ttl was ${Math.floor(
        batch.ttl / DAY_SECONDS,
      )}d)`,
    )
  } catch (error) {
    recordFailure(batchId, String((error as Error)?.message ?? error))
  }
}

function recordSuccessLikeClear(batchId: string): void {
  const settings = getAutoExtendSettings()
  const entry = settings[batchId]

  if (!entry) return
  delete entry.lastFailure
  settings[batchId] = entry
  saveSettings(settings)
}

// ─── Scheduler ───────────────────────────────────────────────────────────────

let timer: ReturnType<typeof setTimeout> | null = null

export function startExtendMonitor(): void {
  const schedule = (delayMs: number) => {
    timer = setTimeout(async () => {
      let hasFailures = false

      try {
        hasFailures = await runExtendCheck()
      } catch (error) {
        logger.error(`auto-extend check crashed: ${error}`)
      }
      schedule(hasFailures ? FAILURE_RETRY_MS : CHECK_INTERVAL_MS)
    }, delayMs)
  }

  schedule(INITIAL_DELAY_MS)
  logger.info(`auto-extend monitor started (threshold ${THRESHOLD_SECONDS / DAY_SECONDS}d)`)
}

export function stopExtendMonitor(): void {
  if (timer) clearTimeout(timer)
  timer = null
}
