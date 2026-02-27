import { create } from 'zustand'

const GATEWAY_KEY = 'swarm-gateway-url'
export const DEFAULT_GATEWAY = 'https://gateway.ethswarm.org'

interface AppState {
  apiKey: string | null
  setApiKey: (key: string) => void
  gatewayUrl: string
  setGatewayUrl: (url: string) => void
}

export const useAppStore = create<AppState>()((set) => ({
  apiKey: null,
  setApiKey: (apiKey) => set({ apiKey }),
  gatewayUrl: localStorage.getItem(GATEWAY_KEY) ?? DEFAULT_GATEWAY,
  setGatewayUrl: (gatewayUrl) => {
    localStorage.setItem(GATEWAY_KEY, gatewayUrl)
    set({ gatewayUrl })
  },
}))
