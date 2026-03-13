// Bee node API client — talks directly to the Bee node (default: localhost:1633)
// In dev the Vite proxy forwards /bee-api/* → localhost:1633/*

import { createTar } from '../utils/tar'
import type { FileEntry } from '../utils/directory'

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
      if (xhr.status >= 200 && xhr.status < 300) resolve(xhr.response as UploadResult)
      else reject(new Error(`Upload failed: ${xhr.status}`))
    }
    xhr.onerror = () => reject(new Error('Upload failed'))
    xhr.send(body)
  })
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
}

export interface Stamp {
  batchID: string
  utilization: number
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
}

export interface UploadResult {
  reference: string // Swarm hash
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

// Effective (realistic) capacity per depth — accounts for bucket overflow.
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

/** Effective capacity in bytes for a given stamp depth */
export function depthToBytes(depth: number): number {
  return EFFECTIVE_CAPACITY[depth] ?? (1 << depth) * 4096
}

/** Human-readable effective capacity for a given stamp depth */
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
): { amount: string; bzzCost: string } {
  const price = BigInt(currentPrice)
  const durationBlocks = BigInt(months) * BLOCKS_PER_MONTH
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

export const SIZE_PRESETS = [
  { label: '110 MB', depth: 19 },
  { label: '680 MB', depth: 20 },
  { label: '2.6 GB', depth: 21 },
  { label: '7.7 GB', depth: 22 },
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

  topupStamp: async (id: string, amount: string) =>
    beeRequest<{ batchID: string }>(`/stamps/topup/${id}/${amount}`, { method: 'PATCH' }),

  uploadFileWithProgress: async (
    file: File,
    stampId: string,
    onProgress?: (pct: number) => void,
    deferred = true,
  ): Promise<UploadResult> =>
    xhrUpload(
      `${getBeeUrl()}/bzz`,
      file,
      {
        'swarm-postage-batch-id': stampId,
        'swarm-deferred-upload': deferred ? 'true' : 'false',
        'Content-Type': file.type || 'application/octet-stream',
        'Content-Disposition': `inline; filename="${encodeURIComponent(file.name)}"`,
      },
      onProgress,
    ),

  uploadCollectionWithProgress: async (
    entries: FileEntry[],
    stampId: string,
    options?: { indexDocument?: string; errorDocument?: string; deferred?: boolean },
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
}
