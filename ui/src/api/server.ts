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
  folderId?: string
}

export interface ReclaimableFolder {
  id: string
  name: string
}

export interface ReclaimableUsage {
  totalSlots: number
  occupiedSlots: number
  freeSlots: number
  slotsPerBucket: number
  mostUtilizedBucket: number
  mostUtilizedCount: number
}

export interface ReclaimableDrive {
  batchId: string
  depth: number
  encrypted: boolean
  label?: string
  createdAt: string
  folders: ReclaimableFolder[]
  files: ReclaimableFile[]
  usage: ReclaimableUsage | null
  // On-chain validity (#106): null = unknown (Bee down or still syncing)
  expired: boolean | null
  batchTTL: number | null
}

export interface AutoExtendEntry {
  enabled: boolean
  /** Months added per automatic extension — same options as manual Extend. */
  months: number
  lastExtendedAt?: number
  lastFailure?: { at: number; reason: string }
  /** Set while the drive is in the advance-notice window (#138). */
  notifiedUpcomingAt?: number
  notifiedBlockedAt?: number
}

export interface ActivityRow {
  hash?: string
  at: number
  direction: 'in' | 'out'
  asset: 'xBZZ' | 'xDAI'
  amount: string
  counterparty?: string
  label?: string
}

export interface WalletActivity {
  rows: ActivityRow[]
  degraded: boolean
}

export interface NookNotification {
  id: string
  type: string
  title: string
  body: string
  createdAt: number
  readAt?: number
  link?: string
  data?: Record<string, string | number>
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

  /** First-contact ping on the swarm-notify registry, signed + paid by the node wallet. Resolves once confirmed. */
  notifyPing: async (data: string) => serverPost<{ success: boolean; txHash: string }>('/notify-ping', { data }),

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

  /** Folder upload: create a staging area, add files by relative path, commit */
  createReclaimableStage: async (batchId: string) =>
    serverPost<{ stageId: string }>(`/reclaimable/${batchId}/stage`, {}),

  addFileToReclaimableStage: async (stageId: string, relPath: string, file: File) => {
    const response = await fetch(`/reclaimable/stage/${stageId}/file?path=${encodeURIComponent(relPath)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', ...authHeaders() },
      body: file,
    })

    if (!response.ok) {
      const body = await response.json().catch(() => null)
      throw new Error(body?.message ?? `${response.status} error`)
    }

    return response.json() as Promise<{ fileCount: number }>
  },

  commitReclaimableStage: async (stageId: string, name: string) =>
    serverPost<{ uploadId: string }>(`/reclaimable/stage/${stageId}/commit?name=${encodeURIComponent(name)}`, {}),

  /** Organizational folders — server-side grouping, no Swarm objects */
  createReclaimableFolder: async (batchId: string, name: string) =>
    serverPost<ReclaimableFolder>(`/reclaimable/${batchId}/folders`, { name }),

  deleteReclaimableFolder: async (batchId: string, folderId: string) => {
    const response = await fetch(`/reclaimable/${batchId}/folders/${folderId}`, {
      method: 'DELETE',
      headers: authHeaders(),
    })

    if (!response.ok) throw new Error('Could not delete the folder')

    return response.json() as Promise<{ deleted: boolean }>
  },

  moveReclaimableFile: async (batchId: string, reference: string, folderId: string | null) =>
    serverPatch<{ moved: boolean }>(`/reclaimable/${batchId}/files/${reference}/folder`, { folderId }),

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

  // Remove an EXPIRED drive's record (registry + ledger + folders, #106).
  // The server refuses this for drives still live on-chain.
  removeReclaimableDrive: async (batchId: string) => {
    const response = await fetch(`/reclaimable/${batchId}`, {
      method: 'DELETE',
      headers: authHeaders(),
    })

    if (!response.ok) {
      const body = await response.json().catch(() => null)
      throw new Error(body?.message ?? `${response.status} error`)
    }

    return response.json() as Promise<{ removed: boolean }>
  },

  // ─── Wallet activity (#139) ─────────────────────────────────────────────

  getWalletActivity: async () => serverGet<WalletActivity>('/wallet-activity'),

  // ─── Notifications (#138) — the bell's event feed ───────────────────────

  getNotifications: async () => serverGet<{ notifications: NookNotification[] }>('/notifications'),

  /** Manual reserve creation (#13) — same guarded purchase pass as the monitor, right now. */
  createSystemStamp: async () => {
    const response = await fetch('/system-stamp/create', { method: 'POST', headers: authHeaders() })

    if (!response.ok) throw new Error(`${response.status} error`)

    return response.json() as Promise<{ result: 'exists' | 'bought' | 'skipped' | 'failed'; created: boolean }>
  },

  getUpdateInfo: async () =>
    serverGet<{ current: string; latest: string | null; url: string | null; updateAvailable: boolean }>('/update'),

  markNotificationsRead: async (ids?: string[]) => {
    const response = await fetch('/notifications/read', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify(ids ? { ids } : {}),
    })

    if (!response.ok) throw new Error(`${response.status} error`)

    return response.json() as Promise<{ marked: number }>
  },

  /** Client-created bell event (e.g. "upload reached the network", #4/#5). */
  createNotification: async (input: { type: string; title: string; body: string; link?: string }) => {
    const response = await fetch('/notifications', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify(input),
    })

    if (!response.ok) throw new Error(`${response.status} error`)

    return response.json() as Promise<{ notification: NookNotification }>
  },

  dismissNotification: async (id: string) => {
    const response = await fetch('/notifications/dismiss', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ id }),
    })

    if (!response.ok) throw new Error(`${response.status} error`)

    return response.json() as Promise<{ dismissed: boolean }>
  },

  // ─── Auto-extend (#129) — per-drive keep-alive settings ─────────────────

  getAutoExtend: async () => serverGet<{ settings: Record<string, AutoExtendEntry> }>('/auto-extend'),

  setAutoExtend: async (batchId: string, enabled: boolean, months: number) => {
    const response = await fetch(`/auto-extend/${batchId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ enabled, months }),
    })

    if (!response.ok) {
      const body = await response.json().catch(() => null)
      throw new Error(body?.message ?? `${response.status} error`)
    }

    return response.json() as Promise<{ entry: AutoExtendEntry }>
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
