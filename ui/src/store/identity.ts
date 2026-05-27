/**
 * Identity store — holds the wallet-derived signer.
 *
 * Primary persistence: Electron safeStorage (OS keychain), accessed via the
 * Koa /identity-cache endpoint. The encrypted blob lives at paths.data/
 * identity-cache.bin on disk. This means the user signs the derivation
 * message once and the signer survives app restarts.
 *
 * Fallback: when safeStorage isn't available (Linux without keyring),
 * sessionStorage takes over — signer survives refresh but not app quit.
 *
 * Never written to localStorage or anywhere else.
 */
import { create } from 'zustand'

import { serverApi } from '../api/server'
import { createWalletSigner, type NookSigner } from '../crypto/signer'

const SESSION_STORAGE_KEY = 'nook.derivedKey.v1'

interface PersistedShape {
  signatureHex: string
  walletAddress: string
}

function parsePersisted(raw: string | null): PersistedShape | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as PersistedShape
    if (typeof parsed.signatureHex !== 'string' || typeof parsed.walletAddress !== 'string') return null

    return parsed
  } catch {
    return null
  }
}

function readSession(): PersistedShape | null {
  if (typeof window === 'undefined') return null
  try {
    return parsePersisted(window.sessionStorage.getItem(SESSION_STORAGE_KEY))
  } catch {
    return null
  }
}

function writeSession(value: PersistedShape): void {
  if (typeof window === 'undefined') return
  try {
    window.sessionStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(value))
  } catch {
    // private mode / quota — fail silently
  }
}

function clearSession(): void {
  if (typeof window === 'undefined') return
  try {
    window.sessionStorage.removeItem(SESSION_STORAGE_KEY)
  } catch {
    // ignore
  }
}

type Backend = 'safe-storage' | 'session-storage'

interface IdentityState {
  signer: NookSigner | null
  walletAddress: string | null
  /** True once the initial hydrate attempt has completed (success OR no cache found). */
  hydrated: boolean
  /** Which storage layer is active; null until hydrate runs. */
  backend: Backend | null
  deriving: boolean
  error: string | null

  /** Async-load any previously persisted signer. Idempotent — only runs once. */
  hydrate: () => Promise<void>
  /** Persist the signature and rebuild the in-memory signer. */
  setSigner: (signatureHex: string, walletAddress: string) => Promise<void>
  setDeriving: (deriving: boolean) => void
  setError: (error: string | null) => void
  /** Wipe both safeStorage and sessionStorage caches and reset state. */
  clear: () => Promise<void>
}

export const useIdentityStore = create<IdentityState>()((set, get) => ({
  signer: null,
  walletAddress: null,
  hydrated: false,
  backend: null,
  deriving: false,
  error: null,

  hydrate: async () => {
    if (get().hydrated) return
    // Try safeStorage first
    try {
      const { available, value } = await serverApi.readIdentityCache()
      if (available) {
        const parsed = parsePersisted(value)
        if (parsed) {
          try {
            const signer = createWalletSigner(parsed.signatureHex)
            set({
              signer,
              walletAddress: parsed.walletAddress,
              hydrated: true,
              backend: 'safe-storage',
            })

            return
          } catch {
            // Corrupt cache; clear and continue
            await serverApi.clearIdentityCache().catch(() => undefined)
          }
        }
        set({ hydrated: true, backend: 'safe-storage' })

        return
      }
    } catch {
      // backend unreachable — fall through to session storage
    }
    // Fallback: sessionStorage
    const persisted = readSession()
    if (persisted) {
      try {
        const signer = createWalletSigner(persisted.signatureHex)
        set({
          signer,
          walletAddress: persisted.walletAddress,
          hydrated: true,
          backend: 'session-storage',
        })

        return
      } catch {
        clearSession()
      }
    }
    set({ hydrated: true, backend: 'session-storage' })
  },

  setSigner: async (signatureHex, walletAddress) => {
    const signer = createWalletSigner(signatureHex)
    set({ signer, walletAddress, deriving: false, error: null })

    // Try safeStorage; fall back to sessionStorage if unavailable or call fails
    try {
      const result = await serverApi.writeIdentityCache(JSON.stringify({ signatureHex, walletAddress }))
      if (result.stored) {
        set({ backend: 'safe-storage' })

        return
      }
    } catch {
      // fall through
    }
    writeSession({ signatureHex, walletAddress })
    set({ backend: 'session-storage' })
  },

  setDeriving: deriving => set({ deriving }),
  setError: error => set({ error, deriving: false }),

  clear: async () => {
    clearSession()
    try {
      await serverApi.clearIdentityCache()
    } catch {
      // ignore — best effort
    }
    set({ signer: null, walletAddress: null, deriving: false, error: null })
  },
}))
