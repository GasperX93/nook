import { create } from 'zustand'

export const DEFAULT_GATEWAY = 'https://gateway.ethswarm.org'

const DEV_MODE_KEY = 'nook-dev-mode'

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
  devMode: localStorage.getItem(DEV_MODE_KEY) === 'true',
  setDevMode: devMode => {
    localStorage.setItem(DEV_MODE_KEY, String(devMode))
    set({ devMode })
  },
}))
