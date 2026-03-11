import { RainbowKitProvider, darkTheme } from '@rainbow-me/rainbowkit'
import '@rainbow-me/rainbowkit/styles.css'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { HashRouter } from 'react-router-dom'
import { WagmiProvider } from 'wagmi'
import App from './App'
import './index.css'
import { useAppStore } from './store/app'
import { wagmiConfig } from './wagmi'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      staleTime: 5_000,
    },
  },
})

// Read API key from URL (?v=...) — injected by the Electron backend when opening the dashboard.
// Falls back to VITE_API_KEY for local development without the Electron wrapper.
const params = new URLSearchParams(window.location.search)
const apiKey = params.get('v') ?? import.meta.env.VITE_API_KEY ?? null

if (apiKey) {
  useAppStore.getState().setApiKey(apiKey)
}

const container = document.getElementById('root')!

createRoot(container).render(
  <React.StrictMode>
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <RainbowKitProvider theme={darkTheme({ accentColor: '#262a36', accentColorForeground: '#f0f4f8' })}>
          <HashRouter>
            <App />
          </HashRouter>
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  </React.StrictMode>,
)
