import type { Context } from 'koa'
import { readConfigYaml } from './config'
import { logger } from './logger'
import { isAutomaticRpc, RELAY_PORT, RPC_FALLBACK, RPC_PRIMARY, RPC_RELAY_URL } from './rpc-endpoints'

/**
 * Gnosis Chain RPC with automatic fallback (R5-3 / R5-14, user decision
 * 2026-09-24: "option 3").
 *
 * Bee takes exactly ONE `blockchain-rpc-endpoint` (verified: `bee start --help`
 * lists a single string), so it can't fail over by itself. Instead Bee — and
 * Nook's own providers — talk to a small relay in Nook's backend
 * (`/rpc` on the pinned port), which forwards each JSON-RPC request to the
 * primary public RPC and retries on the fallback when the primary throttles.
 *
 * Endpoint choice (tested 2026-09-24 on eth_getLogs over the postage contract,
 * the call Bee's re-sync makes hundreds of times):
 * - rpc.gnosischain.com — official, fast; the one that returned 429 during
 *   Bee re-syncs and cheque bursts in round 5.
 * - gnosis-rpc.publicnode.com — independent infrastructure (Cloudflare),
 *   getLogs over 5,000 blocks fine.
 * - NOT rpc.gnosis.gateway.fm: a DNS alias of rpc.gnosischain.com (same
 *   quota), so it would throttle at the same moment.
 *
 * A custom RPC the user sets in Settings is used directly — no relay, no
 * second-guessing an endpoint someone chose on purpose.
 */
export { isAutomaticRpc, RELAY_PORT, RPC_FALLBACK, RPC_PRIMARY, RPC_RELAY_URL } from './rpc-endpoints'

/** After the preferred endpoint throttles, stay on the other one this long. */
export const COOLDOWN_MS = 5 * 60_000
const ATTEMPT_TIMEOUT_MS = 30_000
const MAX_BODY_BYTES = 1_000_000

/** The URL Nook's own ethers providers should use: the user's custom RPC, or the relay. */
export function nookRpcUrl(): string {
  let configured: unknown

  try {
    configured = readConfigYaml()['blockchain-rpc-endpoint']
  } catch {
    configured = undefined
  }

  return isAutomaticRpc(configured) ? RPC_RELAY_URL : (configured as string)
}

// ── Failover state ──────────────────────────────────────────────────────────

let preferFallbackUntil = 0

/** Order to try the endpoints in right now. Exported for tests. */
export function endpointOrder(now = Date.now()): string[] {
  return now < preferFallbackUntil ? [RPC_FALLBACK, RPC_PRIMARY] : [RPC_PRIMARY, RPC_FALLBACK]
}

/** Test hook. */
export function resetFailover(): void {
  preferFallbackUntil = 0
}

let lastFailoverLog = 0

function noteFailure(endpoint: string, reason: string, now: number): void {
  if (endpoint === RPC_PRIMARY) {
    preferFallbackUntil = now + COOLDOWN_MS

    if (now - lastFailoverLog > 60_000) {
      lastFailoverLog = now
      logger.info(`rpc: ${endpoint} ${reason} — using ${RPC_FALLBACK} for ${COOLDOWN_MS / 60_000} min`)
    }
  }
}

function noteSuccess(endpoint: string): void {
  // The primary answered during a cooldown (fallback was failing too): go back.
  if (endpoint === RPC_PRIMARY) preferFallbackUntil = 0
}

// ── Throttle detection ──────────────────────────────────────────────────────

/**
 * JSON-RPC errors some providers return inside an HTTP 200 that mean "this
 * endpoint can't serve it — ask the other one": throttling, and per-provider
 * caps such as publicnode's 50,000-block eth_getLogs limit ("exceed maximum
 * block range: 50000", verified 2026-09-24) that rpc.gnosischain.com serves.
 */
const THROTTLE_MESSAGE =
  /rate.?limit|too many requests|limit exceeded|request limit|capacity|block range|range limit|range is too large|exceed maximum/i

/** Whether an upstream answer means "try the other endpoint". Exported for tests. */
export function isRetryableAnswer(status: number, bodyText: string): boolean {
  if (status === 429 || status >= 500) return true

  if (status !== 200) return false

  try {
    const parsed = JSON.parse(bodyText)
    const items = Array.isArray(parsed) ? parsed : [parsed]

    return items.some(
      (item: { error?: { code?: number; message?: string } }) =>
        item?.error && (item.error.code === -32005 || THROTTLE_MESSAGE.test(item.error.message ?? '')),
    )
  } catch {
    // Not JSON on a 200 — something in between (captive portal, proxy page).
    return true
  }
}

/** Methods that must not be sent twice when the first attempt's fate is unknown. */
function sendsTransaction(bodyText: string): boolean {
  return bodyText.includes('eth_sendRawTransaction') || bodyText.includes('eth_sendTransaction')
}

interface Attempt {
  status: number
  body: string
  contentType: string
}

/** Connection errors that happen before a single byte was sent. */
const PRE_CONNECT_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH'])

/** Whether a failed fetch provably never reached the endpoint (safe to resend a transaction). */
function neverConnected(error: unknown): boolean {
  const code = (error as { cause?: { code?: string } })?.cause?.code ?? (error as { code?: string })?.code ?? ''

  return PRE_CONNECT_CODES.has(code)
}

async function forward(endpoint: string, bodyText: string): Promise<Attempt> {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: bodyText,
    signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS),
  })

  return {
    status: res.status,
    body: await res.text(),
    contentType: res.headers.get('content-type') ?? 'application/json',
  }
}

/**
 * Forward one JSON-RPC payload with failover. Exported for tests (fetch is
 * global and mockable).
 *
 * Transactions are only retried when the first endpoint clearly REFUSED them
 * (429, or the connection never opened) — never after a timeout, a dropped
 * connection or a 5xx, where the transaction may already be in the mempool
 * and a second send could confuse nonce handling or report a sent
 * transaction as failed.
 */
export async function relayJsonRpc(bodyText: string, now = Date.now()): Promise<Attempt> {
  const order = endpointOrder(now)
  const isTx = sendsTransaction(bodyText)
  let last: Attempt | null = null

  for (let i = 0; i < order.length; i++) {
    const endpoint = order[i]
    const isLast = i === order.length - 1

    try {
      const answer = await forward(endpoint, bodyText)

      if (isLast || !isRetryableAnswer(answer.status, answer.body)) {
        if (!isRetryableAnswer(answer.status, answer.body)) noteSuccess(endpoint)

        return answer
      }

      if (isTx && answer.status !== 429) return answer
      noteFailure(endpoint, `answered ${answer.status}`, now)
      last = answer
    } catch (error) {
      const name = (error as Error).name
      const timedOut = name === 'TimeoutError' || name === 'AbortError'

      if (isLast || (isTx && !neverConnected(error))) {
        if (last) return last

        return {
          status: 502,
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: null,
            error: { code: -32603, message: 'Gnosis RPC unreachable' },
          }),
          contentType: 'application/json',
        }
      }
      noteFailure(endpoint, timedOut ? 'timed out' : 'unreachable', now)
    }
  }

  // Unreachable in practice (the loop returns on the last endpoint).
  return last as Attempt
}

// ── Koa middleware ──────────────────────────────────────────────────────────

async function readBody(context: Context): Promise<string | null> {
  const chunks: Buffer[] = []
  let size = 0

  for await (const chunk of context.req) {
    size += (chunk as Buffer).length

    if (size > MAX_BODY_BYTES) return null
    chunks.push(chunk as Buffer)
  }

  return Buffer.concat(chunks).toString('utf8')
}

/**
 * The server listens on every interface, and a Host header is just text — so
 * also require the connection itself to come from this machine. Otherwise any
 * device on the same network could use the relay as a free Gnosis RPC and
 * burn the rate limit Bee depends on.
 */
export function isLoopback(address: string | undefined): boolean {
  if (!address) return false
  const a = address.replace(/^::ffff:/, '')

  return a === '::1' || a.startsWith('127.')
}

function fromThisMachine(context: Context): boolean {
  return isLoopback(context.req.socket?.remoteAddress)
}

/**
 * `POST /rpc` — the relay Bee and Nook's providers point at. Unauthenticated
 * (Bee can't send Nook's API key), so it only serves local, non-browser
 * callers: the connection and the Host must be this machine and there must be no Origin header
 * (browsers always send Origin on POST — that blocks web pages and DNS
 * rebinding). It only relays public-chain JSON-RPC; it holds no keys.
 * Registered before the body parser so the raw body is intact.
 */
export async function rpcRelayMiddleware(context: Context, next: () => Promise<unknown>): Promise<void> {
  if (context.path !== '/rpc') {
    await next()

    return
  }

  const host = (context.headers.host ?? '').toLowerCase()
  const localHost = host === `127.0.0.1:${RELAY_PORT}` || host === `localhost:${RELAY_PORT}`

  if (context.method !== 'POST' || !localHost || !fromThisMachine(context) || context.headers.origin) {
    context.status = 403
    context.body = { error: 'forbidden' }

    return
  }

  const bodyText = await readBody(context)

  if (bodyText === null) {
    context.status = 413
    context.body = { error: 'request too large' }

    return
  }

  const answer = await relayJsonRpc(bodyText)

  context.status = answer.status
  context.set('content-type', answer.contentType)
  context.body = answer.body
}
