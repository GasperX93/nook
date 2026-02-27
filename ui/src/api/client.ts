import { useAppStore } from '../store/app'

function getBaseUrl(): string {
  return import.meta.env.VITE_BEE_DESKTOP_URL ?? `${window.location.protocol}//${window.location.host}`
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const apiKey = useAppStore.getState().apiKey
  const url = `${getBaseUrl()}${path}`

  const response = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(apiKey ? { authorization: apiKey } : {}),
      ...options?.headers,
    },
  })

  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`)
  }

  const contentType = response.headers.get('content-type') ?? ''

  if (contentType.includes('application/json')) {
    return response.json() as Promise<T>
  }

  return response.text() as unknown as Promise<T>
}

export type NodeStatus = 'starting' | 'running' | 'stopped' | 'error'

export interface Info {
  name: string
  version: string
  autoUpdateEnabled: boolean
}

export interface Status {
  bee: NodeStatus
  config: Record<string, unknown> | null
}

export interface Peers {
  connections: number
}

export const api = {
  getInfo: async () => request<Info>('/info'),
  getStatus: async () => request<Status>('/status'),
  getPeers: async () => request<Peers>('/peers'),
  getConfig: async () => request<Record<string, unknown>>('/config'),
  updateConfig: async (config: Record<string, unknown>) =>
    request<Record<string, unknown>>('/config', { method: 'POST', body: JSON.stringify(config) }),
  getDesktopLogs: async () => request<string>('/logs/bee-desktop'),
  getBeeLogs: async () => request<string>('/logs/bee'),
  restart: async () => request<{ success: boolean }>('/restart', { method: 'POST' }),
  redeem: async (giftCode: string) =>
    request<{ success: boolean }>('/redeem', { method: 'POST', body: JSON.stringify({ giftCode }) }),
}
