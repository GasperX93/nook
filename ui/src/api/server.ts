// Nook server API client — talks to the Koa backend (same origin in prod, proxied in dev)
import { useAppStore } from '../store/app'

function authHeaders(): Record<string, string> {
  const apiKey = useAppStore.getState().apiKey

  return apiKey ? { Authorization: apiKey } : {}
}

// ─── Reclaimable drive types (#99) ────────────────────────────────────────────

export interface ReclaimableFile {
  name: string
  reference: string
  kind: string
  chunkCount: number
  uploadDate?: number
}

export interface ReclaimableUsage {
  totalSlots: number
  occupiedSlots: number
  freeSlots: number
  slotsPerBucket: number
}

export interface ReclaimableDrive {
  batchId: string
  depth: number
  encrypted: boolean
  label?: string
  createdAt: string
  files: ReclaimableFile[]
  usage: ReclaimableUsage | null
}

export interface ReclaimableUploadJob {
  id: string
  batchId: string
  fileName: string
  chunksUploaded: number
  status: 'uploading' | 'done' | 'error'
  reference?: string
  error?: string
}

async function serverPost<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(body),
  })

  if (!response.ok) {
    let message: string
    try {
      const body = await response.json()
      message = body.message ?? `${response.status} error`
    } catch {
      message = await response.text().catch(() => `${response.status} error`)
    }
    throw new Error(message)
  }

  return response.json() as Promise<T>
}

async function serverGet<T>(path: string): Promise<T> {
  const response = await fetch(path, {
    headers: authHeaders(),
  })

  if (!response.ok) {
    let message: string
    try {
      const body = await response.json()
      message = body.message ?? `${response.status} error`
    } catch {
      message = await response.text().catch(() => `${response.status} error`)
    }
    throw new Error(message)
  }

  return response.json() as Promise<T>
}

async function serverPatch<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(path, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(body),
  })

  if (!response.ok) {
    let message: string
    try {
      const body = await response.json()
      message = body.message ?? `${response.status} error`
    } catch {
      message = await response.text().catch(() => `${response.status} error`)
    }
    throw new Error(message)
  }

  return response.json() as Promise<T>
}

export const serverApi = {
  /**
   * Create a Swarm feed update (signed SOC) using the Bee node's private key.
   * Returns the permanent feed manifest address.
   */
  createFeedUpdate: async (topicHex: string, reference: string, stampId: string) =>
    serverPost<{ feedManifestAddress: string }>('/feed-update', { topicHex, reference, stampId }),

  /**
   * Buy a postage stamp via the Nook backend.
   * Proxied through the server so that the immutable header is sent correctly
   * (Electron renderer fetch strips custom headers on localhost requests).
   */
  buyStamp: async (amount: string, depth: number, immutable: boolean, label?: string) =>
    serverPost<{ batchID: string }>('/buy-stamp', { amount, depth, immutable, label }),

  withdraw: async (token: 'bzz' | 'dai', amount: string, to: string) =>
    serverPost<{ success: boolean; txHash: string }>('/withdraw', { token, amount, to }),

  chequebookWithdraw: async (amount: string) =>
    serverPost<{ success: boolean; transactionHash: string }>('/chequebook-withdraw', { amount }),

  // ─── ACT operations ─────────────────────────────────────────────────────

  /** Read a Swarm feed by topic + owner */
  readFeed: async (topic: string, owner: string) => {
    const params = new URLSearchParams({ topic, owner })
    const response = await fetch(`/feed-read?${params}`, { headers: authHeaders() })

    if (!response.ok) throw new Error('Feed not found')

    return response.text()
  },

  /** Upload raw bytes to Swarm (non-ACT, for feed wrappers) */
  uploadRawBytes: async (stampId: string, data: string) =>
    serverPost<{ reference: string }>('/upload-bytes', { stampId, data }),

  /** Upload a small data blob with ACT encryption (for metadata) */
  uploadACTMetadata: async (stampId: string, data: string, historyRef?: string) =>
    serverPost<{ reference: string; historyRef: string }>('/act/upload-metadata', { stampId, data, historyRef }),

  // ─── ACT grantee management ────────────────────────────────────────────

  createGrantees: async (stampId: string, grantees: string[], historyRef?: string) =>
    serverPost<{ ref: string; historyRef: string }>('/grantee', { stampId, grantees, historyRef }),

  getGrantees: async (ref: string) => serverGet<{ grantees: string[] }>(`/grantee/${ref}`),

  patchGrantees: async (ref: string, stampId: string, historyRef: string, add?: string[], revoke?: string[]) =>
    serverPatch<{ ref: string; historyRef: string }>(`/grantee/${ref}`, { stampId, historyRef, add, revoke }),

  // ─── Reclaimable drives (#99) ────────────────────────────────────────────
  // Batches stamped client-side by the server's reclaimable engine: deleting
  // a file frees its slots, so capacity comes back. Files live in the server
  // ledger (not localStorage) and every upload is direct (receipt-backed).

  listReclaimable: async () => serverGet<{ drives: ReclaimableDrive[] }>('/reclaimable'),

  createReclaimable: async (amount: string, depth: number, encrypted: boolean, label?: string) =>
    serverPost<{ batchID: string }>('/reclaimable', { amount, depth, encrypted, label }),

  /** Raw-bytes upload; returns a job id — poll getReclaimableUpload for receipt-confirmed progress */
  uploadReclaimableFile: async (batchId: string, file: File) => {
    const response = await fetch(`/reclaimable/${batchId}/upload?name=${encodeURIComponent(file.name)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', ...authHeaders() },
      body: file,
    })

    if (!response.ok) {
      const body = await response.json().catch(() => null)
      throw new Error(body?.message ?? `${response.status} error`)
    }

    return response.json() as Promise<{ uploadId: string }>
  },

  getReclaimableUpload: async (id: string) => serverGet<ReclaimableUploadJob>(`/reclaimable/upload/${id}`),

  deleteReclaimableFile: async (batchId: string, reference: string) => {
    const response = await fetch(`/reclaimable/${batchId}/files/${reference}`, {
      method: 'DELETE',
      headers: authHeaders(),
    })

    if (!response.ok) {
      const body = await response.json().catch(() => null)
      throw new Error(body?.message ?? `${response.status} error`)
    }

    return response.json() as Promise<{ deleted: boolean; usage: ReclaimableUsage }>
  },

  // ─── Identity cache (Electron safeStorage, OS keychain) ─────────────────

  readIdentityCache: async () => serverGet<{ available: boolean; value: string | null }>('/identity-cache'),

  writeIdentityCache: async (value: string) =>
    serverPost<{ stored: boolean; available: boolean }>('/identity-cache', { value }),

  clearIdentityCache: async () => {
    const response = await fetch('/identity-cache', { method: 'DELETE', headers: authHeaders() })

    if (!response.ok) throw new Error('Failed to clear identity cache')

    return (await response.json()) as { cleared: boolean }
  },
}
