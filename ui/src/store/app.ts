import { create } from 'zustand'

export const DEFAULT_GATEWAY = 'https://gateway.ethswarm.org'

interface AppState {
  apiKey: string | null
  setApiKey: (key: string) => void
  gatewayUrl: string
  devMode: boolean
  setDevMode: (enabled: boolean) => void
}

export const useAppStore = create<AppState>()(set => ({
  apiKey: null,
  setApiKey: apiKey => set({ apiKey }),
  gatewayUrl: DEFAULT_GATEWAY,
  devMode: false,
  setDevMode: devMode => set({ devMode }),
}))
