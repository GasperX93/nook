// Bee node API client — talks directly to the Bee node (default: localhost:1633)
// In dev the Vite proxy forwards /bee-api/* → localhost:1633/*

import { createTar } from '../utils/tar'
import type { FileEntry } from '../utils/directory'
import { useAppStore } from '../store/app'

function useAppStoreApiKey(): string {
  return useAppStore.getState().apiKey ?? ''
}

export function getBeeUrl(): string {
  return import.meta.env.VITE_BEE_API_URL ?? 'http://localhost:1633'
}

async function xhrUpload(
  url: string,
  body: XMLHttpRequestBodyInit,
  headers: Record<string, string>,
  onProgress?: (pct: number) => void,
): Promise<UploadResult> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', url)
    for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v)
    xhr.responseType = 'json'

    if (onProgress) {
      xhr.upload.onprogress = e => {
        if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100))
      }
    }
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        const result = xhr.response as UploadResult

        // ACT uploads return historyAddress as a response header, not in the body
        const actHistory = xhr.getResponseHeader('Swarm-Act-History-Address')

        if (actHistory) (result as ACTUploadResult).historyAddress = actHistory
        resolve(result)
      } else reject(new Error(`Upload failed: ${xhr.status}`))
    }
    xhr.onerror = () => reject(new Error('Upload failed'))
    xhr.send(body)
  })
}

/**
 * Bee upload-session tag (#92). Counters (all in chunks):
 * `split` = produced by the splitter, `seen` = already known to the network
 * (dedup), `sent`/`synced` = pushed / receipt-confirmed. For a deferred upload,
 * `(seen + synced) / split` is the true network-propagation progress — the XHR
 * progress bar only measures bytes reaching the LOCAL node.
 */
export interface UploadTag {
  uid: number
  split: number
  seen: number
  sent: number
  synced: number
}

/**
 * Poll a tag until the upload is fully propagated (#92). swarm-cli's pattern:
 * poll every second, and RESET the patience counter whenever progress advances,
 * so slow networks don't time out spuriously — only genuine stalls do.
 * Resolves `{ complete: false }` on stall instead of throwing: the content is
 * safe on the local node and the background pusher keeps working; the caller
 * should proceed with a soft warning, not fail the upload.
 */
export async function waitForTagPropagation(
  uid: number,
  onProgress?: (pct: number) => void,
  opts: { pollMs?: number; maxStalledPolls?: number } = {},
): Promise<{ complete: boolean; tag: UploadTag | null }> {
  const pollMs = opts.pollMs ?? 1000
  const maxStalledPolls = opts.maxStalledPolls ?? 60
  let best = -1
  let stalled = 0
  let tag: UploadTag | null = null

  while (stalled < maxStalledPolls) {
    try {
      tag = await beeRequest<UploadTag>(`/tags/${uid}`)
      const done = tag.seen + tag.synced

      if (tag.split > 0) {
        onProgress?.(Math.min(Math.round((done / tag.split) * 100), 100))

        if (done >= tag.split) return { complete: true, tag }
      }

      if (done > best) {
        best = done
        stalled = 0
      } else {
        stalled++
      }
    } catch {
      stalled++
    }
    await new Promise(r => setTimeout(r, pollMs))
  }

  return { complete: false, tag }
}

/**
 * Confirm a reference is retrievable from the network, with patience (#93).
 * Direct uploads should pass quickly; a just-pushed ref can lag a few seconds.
 * Returns false after `attempts` failures — callers show a soft warning, they
 * don't fail the operation (the content may still propagate).
 */
export async function waitForRetrievable(
  reference: string,
  opts: { attempts?: number; delayMs?: number } = {},
): Promise<boolean> {
  const attempts = opts.attempts ?? 3
  const delayMs = opts.delayMs ?? 4000

  for (let i = 0; i < attempts; i++) {
    try {
      if (await beeApi.checkRetrievable(reference)) return true
    } catch {
      // stewardship endpoint unavailable/timeout — retry
    }

    if (i < attempts - 1) await new Promise(r => setTimeout(r, delayMs))
  }

  return false
}

async function beeRequest<T>(path: string, options?: RequestInit): Promise<T> {
  const url = `${getBeeUrl()}${path}`
  const response = await fetch(url, options)

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`Bee API ${path}: ${response.status} ${text}`)
  }

  const contentType = response.headers.get('content-type') ?? ''

  if (contentType.includes('application/json')) {
    return response.json() as Promise<T>
  }

  return response.text() as unknown as Promise<T>
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface WalletInfo {
  bzzBalance: string // PLUR (1 BZZ = 1e16 PLUR)
  nativeTokenBalance: string // Wei  (1 xDAI = 1e18 Wei)
}

export interface NodeAddresses {
  overlay: string
  underlay: string[]
  ethereum: string // wallet address
  publicKey: string // secp256k1 public key (sharing key for ACT)
}

export interface Stamp {
  batchID: string
  utilization: number
  /** True fractional usage 0–1 (Bee ≥ 2.8.1). Prefer over the worst-case `utilization` bucket metric when present. */
  utilizationRatio?: number
  usable: boolean
  label: string
  depth: number
  amount: string
  bucketDepth: number
  blockNumber: number
  immutableFlag: boolean
  exists: boolean
  batchTTL: number // seconds remaining
}

export interface ChainState {
  block: number
  totalAmount: string
  currentPrice: string // PLUR per chunk per block
  /** Minimum batch validity in blocks enforced by the network (Bee ≥ 2.8.1). */
  minimumValidityBlocks?: number
}

/**
 * Effective fill ratio 0–1 for a stamp. Uses Bee 2.8.1's `utilizationRatio`
 * (true fractional usage) when the node provides it; falls back to the
 * worst-case bucket-fill estimate (`utilization / 2^(depth-bucketDepth)`) on
 * older nodes. The fallback is systematically pessimistic — that's why the
 * ratio is preferred.
 */
export function stampFillRatio(stamp: Stamp): number {
  if (typeof stamp.utilizationRatio === 'number') return Math.min(stamp.utilizationRatio, 1)
  const maxUtilization = 1 << (stamp.depth - stamp.bucketDepth)

  return maxUtilization > 0 ? Math.min(stamp.utilization / maxUtilization, 1) : 0
}

export interface UploadResult {
  reference: string // Swarm hash
}

export interface ACTUploadResult extends UploadResult {
  historyAddress: string // ACT history reference (returned when swarm-act: true)
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const BLOCKS_PER_MONTH = 518_400n // Gnosis chain ~5s blocks
const PLUR_PER_BZZ = 10n ** 16n
const WEI_PER_DAI = 10n ** 18n

/** Convert PLUR string to human-readable BZZ (4 decimals) */
export function plurToBzz(plur: string): string {
  const raw = BigInt(plur)
  const whole = raw / PLUR_PER_BZZ
  const frac = ((raw % PLUR_PER_BZZ) * 10_000n) / PLUR_PER_BZZ

  return `${whole}.${String(frac).padStart(4, '0')}`
}

/** Convert Wei string to human-readable xDAI (4 decimals) */
export function weiToDai(wei: string): string {
  const raw = BigInt(wei)
  const whole = raw / WEI_PER_DAI
  const frac = ((raw % WEI_PER_DAI) * 10_000n) / WEI_PER_DAI

  return `${whole}.${String(frac).padStart(4, '0')}`
}

// Bee's effective (realistic) capacity per depth — accounts for bucket overflow.
// Values from Beeport / Swarm docs. Theoretical capacity is never fully usable
// because chunks distribute unevenly across 2^16 buckets.
const EFFECTIVE_CAPACITY: Record<number, number> = {
  17: 7_000_000, // ~7 MB
  18: 34_000_000, // ~34 MB
  19: 112_000_000, // ~110 MB
  20: 688_000_000, // ~680 MB
  21: 2_600_000_000, // ~2.6 GB
  22: 7_700_000_000, // ~7.7 GB
  23: 20_000_000_000, // ~20 GB
  24: 47_000_000_000, // ~47 GB
  25: 105_000_000_000, // ~105 GB
  26: 228_000_000_000, // ~228 GB
}

// Nook's advertised capacity per depth — what we display to users as the
// stamp's size. Always ≤ effective capacity at the same depth. The gap is
// the overbuy margin: smaller depths overbuy aggressively (24× at depth 21)
// because the worst-case-bucket utilization metric registers very high on
// small uploads otherwise, then taper to ~3× at larger depths where Bee's
// metric naturally tracks real fill more closely.
//
// Legacy depths 19/20 keep the old "label = effective" values for stamps
// purchased before this scheme; new Nook buys land at depth 21+.
const NOOK_DISPLAY_CAPACITY: Record<number, number> = {
  19: 112_000_000, // legacy "110 MB"
  20: 688_000_000, // legacy "680 MB"
  21: 112_000_000, // new "110 MB" (overbought from depth-19 minimum)
  22: 2_600_000_000, // new "2.6 GB"
  23: 7_700_000_000, // new "7.7 GB"
  24: 16_000_000_000, // new "16 GB"
}

/** User-facing (advertised) capacity in bytes for a given stamp depth */
export function depthToBytes(depth: number): number {
  return NOOK_DISPLAY_CAPACITY[depth] ?? EFFECTIVE_CAPACITY[depth] ?? (1 << depth) * 4096
}

/** Human-readable user-facing capacity for a given stamp depth */
export function depthToCapacity(depth: number): string {
  const bytes = depthToBytes(depth)

  if (bytes >= 1_073_741_824) return `${(bytes / 1_073_741_824).toFixed(1)} GB`

  return `${(bytes / 1_048_576).toFixed(0)} MB`
}

/**
 * Calculate the stamp amount and estimated BZZ cost for a given
 * depth and duration, based on the current network price.
 */
export function calcStampCost(
  depth: number,
  months: number,
  currentPrice: string,
  minimumValidityBlocks?: number,
): { amount: string; bzzCost: string } {
  const price = BigInt(currentPrice)
  let durationBlocks = BigInt(months) * BLOCKS_PER_MONTH

  // Safety net (Bee ≥ 2.8.1): the network rejects batches below a minimum
  // validity — a purchase under the floor would waste BZZ. Auto-bump to the
  // minimum with a 5% margin for price drift between quote and buy; the
  // returned cost reflects the bump. Presets are far above the floor, so this
  // only ever fires on misconfiguration or extreme network changes.
  if (minimumValidityBlocks && minimumValidityBlocks > 0) {
    const floorBlocks = (BigInt(minimumValidityBlocks) * 105n) / 100n

    if (durationBlocks < floorBlocks) durationBlocks = floorBlocks
  }
  const amount = price * durationBlocks
  const totalChunks = 1n << BigInt(depth)
  const totalPlur = amount * totalChunks

  return {
    amount: amount.toString(),
    bzzCost: plurToBzz(totalPlur.toString()),
  }
}

/** Hash a human-readable name to a 32-byte topic hex for Swarm feeds (keccak256, matches swarm-cli) */
export async function topicFromString(name: string): Promise<string> {
  const { keccak256 } = await import('ethereum-cryptography/keccak')
  const data = new TextEncoder().encode(name)
  const hash = keccak256(data)

  return Array.from(hash)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
}

// ─── Storage plan presets ─────────────────────────────────────────────────────

// Variable overbuy: small presets are heavily overbought so Bee's worst-case-
// bucket utilization metric stays close to real fill. Larger presets need
// little to no overbuy because the bucket math evens out at higher depth.
// Labels = NOOK_DISPLAY_CAPACITY at the same depth (what users can safely
// store), not Bee's effective capacity (which is always larger here).
export const SIZE_PRESETS = [
  { label: '110 MB', depth: 21 }, // 24× overbuy — cheap, accurate small drive
  { label: '2.6 GB', depth: 22 }, // 3× overbuy
  { label: '7.7 GB', depth: 23 }, // 2.6× overbuy
  { label: '16 GB', depth: 24 }, // 3× overbuy
] as const

export const DURATION_PRESETS = [
  { label: '1 month', months: 1 },
  { label: '3 months', months: 3 },
  { label: '6 months', months: 6 },
  { label: '1 year', months: 12 },
] as const

// ─── API calls ────────────────────────────────────────────────────────────────

export interface Topology {
  population: number
  connected: number
  depth: number
}

export interface ChequebookBalance {
  totalBalance: string
  availableBalance: string
}

export const beeApi = {
  getChequebookBalance: async () => beeRequest<ChequebookBalance>('/chequebook/balance'),
  health: async () => beeRequest<{ status: string; version?: string }>('/health'),
  // /readiness is 'ready' only once the node has warmed up and can push/retrieve
  // chunks — stricter than /health (which is 'ok' as soon as the API is up).
  readiness: async () => beeRequest<{ status: string }>('/readiness'),
  getWallet: async () => beeRequest<WalletInfo>('/wallet'),
  getAddresses: async () => beeRequest<NodeAddresses>('/addresses'),
  getStamps: async () => beeRequest<{ stamps: Stamp[] }>('/stamps'),
  getChainState: async () => beeRequest<ChainState>('/chainstate'),
  getTopology: async () => beeRequest<Topology>('/topology'),

  buyStamp: async (amount: string, depth: number, immutable = false) =>
    beeRequest<{ batchID: string }>(`/stamps/${amount}/${depth}`, {
      method: 'POST',
      headers: { immutable: String(immutable) },
    }),

  getStamp: async (id: string) => beeRequest<Stamp>(`/stamps/${id}`),

  /** Rename a drive — updates the batch label (local node metadata, no chain tx). Bee ≥ 2.8.1. */
  renameStamp: async (id: string, label: string) =>
    beeRequest<{ batchID: string }>(`/stamps/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label }),
    }),

  topupStamp: async (id: string, amount: string) =>
    beeRequest<{ batchID: string }>(`/stamps/topup/${id}/${amount}`, { method: 'PATCH' }),

  /**
   * Dilute (expand capacity of) a postage batch by increasing its depth.
   * For every +1 depth, capacity doubles but remaining time is halved — so a
   * topup typically follows to restore the desired duration. Free at the
   * protocol level (no BZZ paid for the dilute itself).
   */
  diluteStamp: async (id: string, depth: number) =>
    beeRequest<{ batchID: string }>(`/stamps/dilute/${id}/${depth}`, { method: 'PATCH' }),

  /** Create an upload-session tag (#92). Pass its uid to an upload to track network propagation. */
  createTag: async (): Promise<UploadTag> =>
    beeRequest<UploadTag>('/tags', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    }),

  getTag: async (uid: number): Promise<UploadTag> => beeRequest<UploadTag>(`/tags/${uid}`),

  /**
   * Is this reference retrievable from the NETWORK (#93)? One stewardship call —
   * Bee attempts an actual retrieval, so treat it as expensive: on-demand and
   * slow-cadence only, never in fast polls.
   */
  checkRetrievable: async (reference: string): Promise<boolean> => {
    const res = await beeRequest<{ isRetrievable: boolean }>(`/stewardship/${reference}`, {
      signal: AbortSignal.timeout(30_000),
    })

    return res.isRetrievable
  },

  uploadFileWithProgress: async (
    file: File,
    stampId: string,
    onProgress?: (pct: number) => void,
    deferred = true,
    tagUid?: number,
  ): Promise<UploadResult> =>
    xhrUpload(
      `${getBeeUrl()}/bzz`,
      file,
      {
        'swarm-postage-batch-id': stampId,
        'swarm-deferred-upload': deferred ? 'true' : 'false',
        'Content-Type': file.type || 'application/octet-stream',
        'Content-Disposition': `inline; filename="${encodeURIComponent(file.name)}"`,
        ...(tagUid !== undefined ? { 'swarm-tag': String(tagUid) } : {}),
      },
      onProgress,
    ),

  uploadCollectionWithProgress: async (
    entries: FileEntry[],
    stampId: string,
    options?: { indexDocument?: string; errorDocument?: string; deferred?: boolean; tagUid?: number },
    onProgress?: (pct: number) => void,
  ): Promise<UploadResult> => {
    const tar = await createTar(entries)
    const deferred = options?.deferred !== false
    const headers: Record<string, string> = {
      'swarm-postage-batch-id': stampId,
      'swarm-deferred-upload': deferred ? 'true' : 'false',
      'swarm-collection': 'true',
      'Content-Type': 'application/x-tar',
    }

    if (options?.indexDocument) headers['swarm-index-document'] = options.indexDocument

    if (options?.errorDocument) headers['swarm-error-document'] = options.errorDocument

    if (options?.tagUid !== undefined) headers['swarm-tag'] = String(options.tagUid)

    return xhrUpload(`${getBeeUrl()}/bzz`, tar as XMLHttpRequestBodyInit, headers, onProgress)
  },

  downloadFile: async (hash: string, onProgress?: (pct: number) => void): Promise<Blob> => {
    if (!onProgress) {
      const r = await fetch(`${getBeeUrl()}/bzz/${hash}`)

      if (!r.ok) throw new Error(`Download failed: ${r.status}`)

      return r.blob()
    }

    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest()
      xhr.open('GET', `${getBeeUrl()}/bzz/${hash}`)
      xhr.responseType = 'blob'
      xhr.onprogress = e => {
        if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100))
      }
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) resolve(xhr.response as Blob)
        else reject(new Error(`Download failed: ${xhr.status}`))
      }
      xhr.onerror = () => reject(new Error('Download failed'))
      xhr.send()
    })
  },

  downloadBytes: async (hash: string): Promise<Blob> => {
    const r = await fetch(`${getBeeUrl()}/bytes/${hash}`)

    if (!r.ok) throw new Error(`Download failed: ${r.status}`)

    return r.blob()
  },

  uploadFile: async (file: File, stampId: string): Promise<UploadResult> => {
    return fetch(`${getBeeUrl()}/bzz`, {
      method: 'POST',
      headers: {
        'swarm-postage-batch-id': stampId,
        'swarm-deferred-upload': 'true',
        'Content-Type': file.type || 'application/octet-stream',
        'Content-Disposition': `inline; filename="${encodeURIComponent(file.name)}"`,
      },
      body: file,
    }).then(async r => {
      if (!r.ok) throw new Error(`Upload failed: ${r.status}`)

      return r.json() as Promise<UploadResult>
    })
  },

  /**
   * Upload a folder or website as a tar collection.
   * For websites, pass indexDocument (e.g. "index.html") so Bee knows
   * what to serve at the root path.
   */
  uploadCollection: async (
    entries: FileEntry[],
    stampId: string,
    options?: { indexDocument?: string; errorDocument?: string },
  ): Promise<UploadResult> => {
    const tar = await createTar(entries)

    const headers: Record<string, string> = {
      'swarm-postage-batch-id': stampId,
      'swarm-deferred-upload': 'true',
      'swarm-collection': 'true',
      'Content-Type': 'application/x-tar',
    }

    if (options?.indexDocument) headers['swarm-index-document'] = options.indexDocument

    if (options?.errorDocument) headers['swarm-error-document'] = options.errorDocument

    const r = await fetch(`${getBeeUrl()}/bzz`, { method: 'POST', headers, body: tar as BodyInit })

    if (!r.ok) throw new Error(`Upload failed: ${r.status}`)

    return r.json() as Promise<UploadResult>
  },

  // ─── ACT (encrypted drives) ──────────────────────────────────────────────

  /** Upload a single file with ACT encryption */
  uploadFileWithACT: async (
    file: File,
    stampId: string,
    historyRef?: string,
    onProgress?: (pct: number) => void,
  ): Promise<ACTUploadResult> => {
    const headers: Record<string, string> = {
      'swarm-postage-batch-id': stampId,
      // Direct (non-deferred) upload: push chunks to the network's storer nodes
      // synchronously. A deferred upload stays on this (light) node's local
      // store, so a grantee on another node can't retrieve it → 404. Shared
      // content MUST be pushed to the network. Slower, but correct.
      'swarm-deferred-upload': 'false',
      'swarm-act': 'true',
      'Content-Type': file.type || 'application/octet-stream',
      'Content-Disposition': `inline; filename="${encodeURIComponent(file.name)}"`,
    }

    if (historyRef) headers['swarm-act-history-address'] = historyRef

    const result = await xhrUpload(`${getBeeUrl()}/bzz`, file, headers, onProgress)

    return result as ACTUploadResult
  },

  /** Upload a collection (folder/website) with ACT encryption */
  uploadCollectionWithACT: async (
    entries: FileEntry[],
    stampId: string,
    historyRef?: string,
    options?: { indexDocument?: string; errorDocument?: string },
    onProgress?: (pct: number) => void,
  ): Promise<ACTUploadResult> => {
    const tar = await createTar(entries)
    const headers: Record<string, string> = {
      'swarm-postage-batch-id': stampId,
      // Direct upload so shared chunks reach the network's storers (see uploadFileWithACT).
      'swarm-deferred-upload': 'false',
      'swarm-collection': 'true',
      'swarm-act': 'true',
      'Content-Type': 'application/x-tar',
    }

    if (historyRef) headers['swarm-act-history-address'] = historyRef

    if (options?.indexDocument) headers['swarm-index-document'] = options.indexDocument

    if (options?.errorDocument) headers['swarm-error-document'] = options.errorDocument

    const result = await xhrUpload(`${getBeeUrl()}/bzz`, tar as XMLHttpRequestBodyInit, headers, onProgress)

    return result as ACTUploadResult
  },

  /** Download a file from an ACT-encrypted drive (proxied through Koa to avoid CORS) */
  downloadFileWithACT: async (
    hash: string,
    actPublisher: string,
    historyRef: string,
    _onProgress?: (pct: number) => void,
  ): Promise<Blob> => {
    const params = new URLSearchParams({ publisher: actPublisher, history: historyRef })
    const r = await fetch(`/act/download/${hash}?${params}`, {
      headers: { Authorization: useAppStoreApiKey() },
    })

    if (!r.ok) throw new Error(`ACT download failed: ${r.status}`)

    return r.blob()
  },
}
