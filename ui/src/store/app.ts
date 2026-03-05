import { create } from 'zustand'

export const DEFAULT_GATEWAY = 'https://gateway.ethswarm.org'

const ONBOARDING_KEY = 'nook:onboarding-completed'

interface AppState {
  apiKey: string | null
  setApiKey: (key: string) => void
  gatewayUrl: string
  devMode: boolean
  setDevMode: (enabled: boolean) => void
  onboardingCompleted: boolean
  setOnboardingCompleted: () => void
}

export const useAppStore = create<AppState>()(set => ({
  apiKey: null,
  setApiKey: apiKey => set({ apiKey }),
  gatewayUrl: DEFAULT_GATEWAY,
  devMode: false,
  setDevMode: devMode => set({ devMode }),
  onboardingCompleted: localStorage.getItem(ONBOARDING_KEY) === 'true',
  setOnboardingCompleted: () => {
    localStorage.setItem(ONBOARDING_KEY, 'true')
    set({ onboardingCompleted: true })
  },
}))
