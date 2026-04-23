import { create } from 'zustand'

export const DEFAULT_GATEWAY = 'https://gateway.ethswarm.org'

const ONBOARDING_KEY = 'nook:onboarding-completed'
const THEME_KEY = 'nook:theme'

export type Theme = 'dark' | 'light'

function readInitialTheme(): Theme {
  const stored = localStorage.getItem(THEME_KEY)

  return stored === 'dark' ? 'dark' : 'light'
}

function applyThemeClass(theme: Theme) {
  document.documentElement.classList.toggle('dark', theme === 'dark')
  document.documentElement.classList.toggle('light', theme === 'light')
}

interface AppState {
  apiKey: string | null
  setApiKey: (key: string) => void
  gatewayUrl: string
  devMode: boolean
  setDevMode: (enabled: boolean) => void
  onboardingCompleted: boolean
  setOnboardingCompleted: () => void
  theme: Theme
  setTheme: (theme: Theme) => void
}

const initialTheme = readInitialTheme()

applyThemeClass(initialTheme)

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
  theme: initialTheme,
  setTheme: theme => {
    localStorage.setItem(THEME_KEY, theme)
    applyThemeClass(theme)
    set({ theme })
  },
}))
