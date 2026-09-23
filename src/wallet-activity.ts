import { readFileSync } from 'fs'
import { join } from 'path'

import { ethers } from 'ethers'

import { readConfigYaml } from './config'
import { fetchWithTimeout } from './fetch-timeout'
import { logger } from './logger'
import { loadNotifications } from './notifications'
import { getPath } from './path'
import { loadPurchases } from './purchases'
import { NOTIFY_REGISTRY_ADDRESS } from './blockchain'

/**
 * Wallet activity (#139) — the audit surface for a wallet that Nook spends
 * from automatically (#129).
 *
 * Served from the Koa side rather than fetched by the browser: no CORS
 * exposure, one polite (cached) consumer of the public explorer API, and the
 * labels get merged where the records live — Nook's own event ledger. The
 * labeling rule is deliberate: only label what we KNOW (our ledger events,
 * the postage contract); everything else stays honest-raw with an explorer
 * link. Guessing purposes for arbitrary txs is where audit surfaces start
 * lying.
 *
 * Degraded mode: when the explorer is unreachable, return ledger-derived
 * rows (no tx hashes) plus a flag — the wallet-level explorer link in the UI
 * always works.
 */

const EXPLORER_API = 'https://gnosisscan.io/api/v2'

/** Swarm postage contract on Gnosis — every drive purchase/extension pays it. */
const POSTAGE_CONTRACT = '0x45a1502382541cd610cc9068e88727426b696293'

export interface ActivityRow {
  /** Absent in degraded (ledger-only) mode. */
  hash?: string
  /** Unix ms */
  at: number
  direction: 'in' | 'out'
  asset: 'xBZZ' | 'xDAI'
  /** Display amount, already formatted */
  amount: string
  /** Lowercased counterparty address (absent in ledger-only rows) */
  counterparty?: string
  /** Set only when Nook KNOWS what the tx was */
  label?: string
}

export interface WalletActivity {
  rows: ActivityRow[]
  /** True when the explorer API was unreachable and rows are ledger-only. */
  degraded: boolean
}

const BZZ_DECIMALS = BigInt('10000000000000000')
const DAI_DECIMALS = BigInt('1000000000000000000')

/** Ping fees are tiny (~1e-12 xDAI): never render them as a misleading 0.0000. */
function formatFee(wei: bigint): string {
  const shown = formatUnits(wei, DAI_DECIMALS)

  return wei > BigInt(0) && shown === '0.0000' ? '< 0.0001' : shown
}

function formatUnits(value: bigint, divisor: bigint): string {
  return (Number((value * BigInt(10000)) / divisor) / 10_000).toFixed(4)
}

function readNodeWalletAddress(): string {
  const swarmKey = JSON.parse(readFileSync(getPath(join('data-dir', 'keys', 'swarm.key')), 'utf-8')) as {
    address: string
  }

  return `0x${swarmKey.address}`.toLowerCase()
}

// ─── Ledger labels ───────────────────────────────────────────────────────────
// Our own events carry the exact PLUR amounts they moved; an on-chain BZZ
// transfer matching one of them by amount within the event's time vicinity is
// that event. Amount-exact + ±1h window keeps false positives implausible.

interface LedgerEntry {
  amountPlur: bigint
  at: number
  label: string
}

function ledgerEntries(): LedgerEntry[] {
  const entries: LedgerEntry[] = []

  for (const n of loadNotifications()) {
    const plur = n.data?.amountPlur

    if (typeof plur !== 'string') continue

    if (n.type === 'charge-executed') {
      const name = typeof n.data?.driveLabel === 'string' && n.data.driveLabel ? ` · ${n.data.driveLabel}` : ''

      entries.push({ amountPlur: BigInt(plur), at: n.createdAt, label: `Automatic drive extension${name}` })
    } else if (n.type === 'chequebook-funded') {
      entries.push({ amountPlur: BigInt(plur), at: n.createdAt, label: 'Chequebook top-up (bandwidth)' })
    }
  }

  // Nook's own drive purchases/extensions (buy-stamp, reclaimable create,
  // manual topups observed at the proxy) — exact amounts, drive names.
  for (const p of loadPurchases()) {
    const name = p.label ? ` · ${p.label}` : ''

    entries.push({
      amountPlur: BigInt(p.amountPlur),
      at: p.at,
      label: p.kind === 'create' ? `New drive${name}` : `Drive extension${name}`,
    })
  }

  return entries
}

function labelFor(
  row: { direction: string; counterparty?: string; at: number },
  valuePlur: bigint,
  ledger: LedgerEntry[],
  chainOp: ChainStampOp | undefined,
  names: Map<string, string>,
): string | undefined {
  if (row.direction !== 'out') return undefined

  // Most specific first: Nook's own ledger, then the chain-decoded call
  // (names history the ledger predates), then the bare contract match.
  const match = ledger.find(e => e.amountPlur === valuePlur && Math.abs(e.at - row.at) < 60 * 60_000)

  if (match) return match.label

  if (chainOp) {
    const name = names.get(chainOp.batchId)

    return (chainOp.kind === 'create' ? 'New drive' : 'Drive extension') + (name ? ` · ${name}` : '')
  }

  if (row.counterparty === POSTAGE_CONTRACT) return 'Drive purchase or extension'

  return undefined
}

// ─── Chain-decoded labels (history) ──────────────────────────────────────────
// The explorer's transaction list includes the decoded method + parameters of
// every postage-contract call, so payments from BEFORE the purchases ledger
// existed can still be labeled — and named, when the batch is still on this
// node. Verified live against the real wallet: topUp carries `_batchId`
// directly; createBatch's id is keccak256(abi.encode(_owner, _nonce)) (the
// contract uses abi.encode, NOT encodePacked — encodePacked matched 0/18).

interface DecodedParam {
  name: string
  value: string
}

interface ChainStampOp {
  kind: 'create' | 'topup'
  /** Lowercased hex, no 0x prefix — matches Bee's /stamps batchID format. */
  batchId: string
}

function deriveBatchId(owner: string, nonce: string): string {
  return ethers.utils
    .keccak256(ethers.utils.defaultAbiCoder.encode(['address', 'bytes32'], [owner, nonce]))
    .slice(2)
    .toLowerCase()
}

function chainStampOps(txs: ExplorerTx[]): Map<string, ChainStampOp> {
  const ops = new Map<string, ChainStampOp>()

  for (const t of txs) {
    try {
      const params: Record<string, string> = {}

      for (const p of t.decoded_input?.parameters ?? []) params[p.name] = p.value

      if (t.method === 'createBatch' && params._owner && params._nonce) {
        ops.set(t.hash, { kind: 'create', batchId: deriveBatchId(params._owner, params._nonce) })
      } else if (t.method === 'topUp' && params._batchId) {
        ops.set(t.hash, { kind: 'topup', batchId: params._batchId.replace(/^0x/, '').toLowerCase() })
      }
    } catch {
      // Malformed decode — the row keeps its generic label.
    }
  }

  return ops
}

/** batchID → label for batches still on this node. Empty map on any failure. */
async function stampNames(beeFetch: ActivityFetch): Promise<Map<string, string>> {
  try {
    const res = await beeFetch('http://127.0.0.1:1633/stamps')

    if (!res.ok) throw new Error(`stamps ${res.status}`)
    const body = (await res.json()) as { stamps?: { batchID: string; label?: string }[] }
    const names = new Map<string, string>()

    for (const s of body.stamps ?? []) {
      if (s.label) names.set(s.batchID.toLowerCase(), s.label)
    }

    return names
  } catch (error) {
    logger.info(`wallet-activity: stamp names unavailable (${error})`)

    return new Map()
  }
}

// ─── Explorer fetch (cached) ─────────────────────────────────────────────────

interface ExplorerTx {
  hash: string
  timestamp: string
  value: string
  from: { hash: string }
  to: { hash: string } | null
  method?: string | null
  decoded_input?: { parameters?: DecodedParam[] } | null
  /** Gas actually paid, in wei (explorer v2 `fee: { type: 'actual', value }`) */
  fee?: { value?: string } | null
}

interface ExplorerTransfer {
  transaction_hash?: string
  tx_hash?: string
  timestamp: string
  total: { value: string }
  token: { symbol: string }
  from: { hash: string }
  to: { hash: string } | null
}

let cache: { at: number; data: WalletActivity } | null = null

const CACHE_MS = 60_000

export type ActivityFetch = (url: string) => Promise<Response>

const realFetch: ActivityFetch = async url => fetchWithTimeout(url, { redirect: 'follow' }, 15_000)

const realBeeFetch: ActivityFetch = async url => {
  const password = readConfigYaml().password as string | undefined

  return fetchWithTimeout(url, password ? { headers: { Authorization: `Bearer ${password}` } } : {}, 10_000)
}

export async function getWalletActivity(
  fetchFn: ActivityFetch = realFetch,
  beeFetch: ActivityFetch = realBeeFetch,
): Promise<WalletActivity> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.data

  const address = readNodeWalletAddress()
  const ledger = ledgerEntries()

  try {
    const [txRes, transferRes] = await Promise.all([
      fetchFn(`${EXPLORER_API}/addresses/${address}/transactions`),
      fetchFn(`${EXPLORER_API}/addresses/${address}/token-transfers`),
    ])

    if (!txRes.ok || !transferRes.ok) throw new Error(`explorer ${txRes.status}/${transferRes.status}`)
    const txs = ((await txRes.json()) as { items?: ExplorerTx[] }).items ?? []
    const transfers = ((await transferRes.json()) as { items?: ExplorerTransfer[] }).items ?? []

    // Chain-decoded stamp calls; name lookup only when there's something to name.
    const ops = chainStampOps(txs)
    const names = ops.size > 0 ? await stampNames(beeFetch) : new Map<string, string>()

    const rows: ActivityRow[] = []

    for (const t of transfers) {
      if (t.token?.symbol !== 'BZZ') continue
      const value = BigInt(t.total.value)
      const at = Date.parse(t.timestamp)
      const direction = t.from.hash.toLowerCase() === address ? 'out' : 'in'
      const counterparty = (direction === 'out' ? (t.to?.hash ?? '') : t.from.hash).toLowerCase()
      const row: ActivityRow = {
        hash: t.transaction_hash ?? t.tx_hash,
        at,
        direction,
        asset: 'xBZZ',
        amount: formatUnits(value, BZZ_DECIMALS),
        counterparty,
      }

      row.label = labelFor(row, value, ledger, row.hash ? ops.get(row.hash) : undefined, names)
      rows.push(row)
    }

    // Native xDAI movements. Zero-value txs are the wrappers of token
    // operations — skip them; the token row above tells the story.
    const tokenHashes = new Set(rows.map(r => r.hash))

    for (const t of txs) {
      const value = BigInt(t.value || '0')

      // First-contact pings (R4-4) move no xDAI — they cost only gas, paid by
      // the node wallet via /notify-ping. The registry is a contract Nook
      // KNOWS, so the row gets an honest label and the fee as its amount.
      if (
        value === BigInt(0) &&
        t.from.hash.toLowerCase() === address &&
        t.to?.hash.toLowerCase() === NOTIFY_REGISTRY_ADDRESS.toLowerCase()
      ) {
        rows.push({
          hash: t.hash,
          at: Date.parse(t.timestamp),
          direction: 'out',
          asset: 'xDAI',
          amount: formatFee(BigInt(t.fee?.value || '0')),
          counterparty: NOTIFY_REGISTRY_ADDRESS.toLowerCase(),
          label: 'Contact notification (Gnosis)',
        })
        continue
      }

      if (value === BigInt(0) || tokenHashes.has(t.hash)) continue
      const direction = t.from.hash.toLowerCase() === address ? 'out' : 'in'

      rows.push({
        hash: t.hash,
        at: Date.parse(t.timestamp),
        direction,
        asset: 'xDAI',
        amount: formatUnits(value, DAI_DECIMALS),
        counterparty: (direction === 'out' ? (t.to?.hash ?? '') : t.from.hash).toLowerCase(),
      })
    }

    rows.sort((a, b) => b.at - a.at)
    const data: WalletActivity = { rows: rows.slice(0, 50), degraded: false }

    cache = { at: Date.now(), data }

    return data
  } catch (error) {
    logger.info(`wallet-activity: explorer unreachable (${error}) — serving ledger-only`)

    // Ledger-only fallback: what Nook itself recorded, no hashes.
    const rows: ActivityRow[] = ledger
      .map(e => ({
        at: e.at,
        direction: 'out' as const,
        asset: 'xBZZ' as const,
        amount: formatUnits(e.amountPlur, BZZ_DECIMALS),
        label: e.label,
      }))
      .sort((a, b) => b.at - a.at)
      .slice(0, 50)

    return { rows, degraded: true }
  }
}

/** Test seam — the cache would otherwise leak between specs. */
export function resetActivityCacheForTests(): void {
  cache = null
}
