// Nook server API client — talks to the Koa backend (same origin in prod, proxied in dev)
import { useAppStore } from '../store/app'

function authHeaders(): Record<string, string> {
  const apiKey = useAppStore.getState().apiKey

  return apiKey ? { Authorization: apiKey } : {}
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

  /** Upload a small data blob with ACT encryption (for metadata) */
  uploadACTMetadata: async (stampId: string, data: string, historyRef?: string) =>
    serverPost<{ reference: string; historyRef: string }>('/act/upload-metadata', { stampId, data, historyRef }),

  // ─── ACT grantee management ────────────────────────────────────────────

  createGrantees: async (stampId: string, grantees: string[]) =>
    serverPost<{ ref: string; historyRef: string }>('/grantee', { stampId, grantees }),

  getGrantees: async (ref: string) => serverGet<{ grantees: string[] }>(`/grantee/${ref}`),

  patchGrantees: async (ref: string, stampId: string, historyRef: string, add?: string[], revoke?: string[]) =>
    serverPatch<{ ref: string; historyRef: string }>(`/grantee/${ref}`, { stampId, historyRef, add, revoke }),
}
