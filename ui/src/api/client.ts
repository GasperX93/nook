import { useAppStore } from '../store/app'

function getBaseUrl(): string {
  return import.meta.env.VITE_NOOK_URL ?? `${window.location.protocol}//${window.location.host}`
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
    let message: string
    try {
      const body = await response.json()
      message = (body as { message?: string }).message ?? `${response.status} ${response.statusText}`
    } catch {
      message = await response.text().catch(() => `${response.status} ${response.statusText}`)
    }
    throw new Error(message)
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

export type BeeMode = 'ultra-light' | 'light'

export interface Status {
  bee: NodeStatus
  config: Record<string, unknown> | null
  mode: BeeMode
  address?: string
  /** True when the user intentionally stopped Bee via the tray menu. */
  userStopped?: boolean
  /** True when Bee crashed repeatedly and automatic restarts are paused (#94). */
  crashLoop?: boolean
  /** Outstanding auto-extend failures (#129) — drives that couldn't be extended. */
  autoExtendFailures?: { batchId: string; ttlDays: number | null; reason: string; at: number }[]
  /** What the funding monitor last saw (R5-15). */
  funding?: FundingState
  /** Another Bee node holds Nook's ports (R5-11) — the dashboard blocks on this. */
  foreignBee?: ForeignBee | null
}

export interface ForeignBee {
  port: number
  address: string | null
  since: number
}

/** Backend funding monitor state (src/funding-monitor.ts). */
export interface FundingState {
  /** Epoch ms of the last balance check, null before the first one. */
  checkedAt: number | null
  /** Last xDAI balance read, as a decimal string. */
  xdai: string | null
  /** Why the last check failed, else null. */
  error: string | null
  /** Funds found — the node is restarting in light mode. */
  switching: boolean
}

export interface Peers {
  connections: number
}

export const api = {
  getInfo: async () => request<Info>('/info'),
  getStatus: async () => request<Status>('/status'),
  /** Run the funding monitor's balance check now (onboarding "check now", R5-15). */
  checkFunding: async () => request<FundingState>('/funding/check', { method: 'POST' }),
  /** Bee readiness via Nook's backend — always 200, so polling it stays quiet in the console. */
  getBeeReadiness: async () => request<{ ready: boolean }>('/bee-readiness'),
  getPeers: async () => request<Peers>('/peers'),
  getConfig: async () => request<Record<string, unknown>>('/config'),
  updateConfig: async (config: Record<string, unknown>) =>
    request<Record<string, unknown>>('/config', { method: 'POST', body: JSON.stringify(config) }),
  getNookLogs: async () => request<string>('/logs/nook'),
  getBeeLogs: async () => request<string>('/logs/bee'),
  restart: async () => request<{ success: boolean }>('/restart', { method: 'POST' }),
  redeem: async (giftCode: string) =>
    request<{ success: boolean }>('/redeem', { method: 'POST', body: JSON.stringify({ giftCode }) }),
}
