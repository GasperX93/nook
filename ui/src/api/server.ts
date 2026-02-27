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
    const text = await response.text().catch(() => '')
    throw new Error(`Server ${path}: ${response.status} ${text}`)
  }
  return response.json() as Promise<T>
}

export const serverApi = {
  /**
   * Create a Swarm feed update (signed SOC) using the Bee node's private key.
   * Returns the permanent feed manifest address.
   */
  createFeedUpdate: (topicHex: string, reference: string, stampId: string) =>
    serverPost<{ feedManifestAddress: string }>('/feed-update', { topicHex, reference, stampId }),
}
