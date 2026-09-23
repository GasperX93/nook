/**
 * Identity store — holds the Nook signer (seeded by Swarm ID; a pre-Swarm ID
 * cache may still hold a wallet-derived secret, which useDerivedKey never
 * activates).
 *
 * Primary persistence: Electron safeStorage (OS keychain), accessed via the
 * Koa /identity-cache endpoint. The encrypted blob lives at paths.data/
 * identity-cache.bin on disk. This means the user signs in once and the
 * signer survives app restarts.
 *
 * Fallback: when safeStorage isn't available (Linux without keyring),
 * sessionStorage takes over — signer survives refresh but not app quit.
 *
 * Never written to localStorage or anywhere else.
 */
import { create } from 'zustand'

import { serverApi } from '../api/server'
import { createSignerFromSecret, type NookSigner } from '../crypto/signer'

const SESSION_STORAGE_KEY = 'nook.derivedKey.v1'

/**
 * Module-level (shared across ALL useDerivedKey instances) synchronous lock
 * for key derivation. Multiple components mount useDerivedKey at once — Layout's
 * useInboxPolling + useRegistryPolling, plus the current page (and Contacts
 * embeds Messages). On a wallet switch each instance independently sees
 * signer===null and fires its own derive(), so a PER-INSTANCE ref can't stop
 * the pile-up (each instance's ref is its own). This shared flag means only the
 * first caller across the whole app actually signs; the rest bail. Synchronous
 * (plain module var, not React state) so it takes effect before the next render.
 */
let deriveInFlight = false

/** Try to acquire the shared derive lock. Returns false if one is already running. */
export function acquireDeriveLock(): boolean {
  if (deriveInFlight) return false
  deriveInFlight = true

  return true
}

/** Release the shared derive lock. */
export function releaseDeriveLock(): void {
  deriveInFlight = false
}

interface PersistedShape {
  signatureHex: string
  walletAddress: string
  /** Swarm ID account address — THE user-visible identity. */
  sid?: string
  /** Swarm ID account display name at sign-in time. */
  sidName?: string
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

export interface SwarmIdAccount {
  address: string
  name: string
}

interface IdentityState {
  signer: NookSigner | null
  walletAddress: string | null
  /** The Swarm ID account behind the signer (null for legacy wallet identities). */
  swarmIdAccount: SwarmIdAccount | null
  /** True once the initial hydrate attempt has completed (success OR no cache found). */
  hydrated: boolean
  /** Which storage layer is active; null until hydrate runs. */
  backend: Backend | null
  deriving: boolean
  error: string | null

  /**
   * Async-load any previously persisted signer. Idempotent once it succeeds
   * (sets `hydrated`). Returns `true` if the backend was reachable (cache
   * loaded OR confirmed empty) and `false` on a transient error (e.g. Koa not
   * yet up), so the caller can retry without the `hydrated` guard latching.
   */
  hydrate: () => Promise<boolean>
  /** Persist the secret and rebuild the in-memory signer. */
  setSigner: (signatureHex: string, walletAddress: string, account?: SwarmIdAccount) => Promise<void>
  setDeriving: (deriving: boolean) => void
  setError: (error: string | null) => void
  /** Wipe both safeStorage and sessionStorage caches and reset state. */
  clear: () => Promise<void>
}

export const useIdentityStore = create<IdentityState>()((set, get) => ({
  signer: null,
  walletAddress: null,
  swarmIdAccount: null,
  hydrated: false,
  backend: null,
  deriving: false,
  error: null,

  hydrate: async () => {
    if (get().hydrated) return true

    // Try safeStorage first. A THROW here means the backend (Koa) is not
    // reachable yet — a transient condition at boot. We must NOT latch
    // `hydrated` in that case (D8), or a user with a valid safeStorage cache
    // gets permanently downgraded to session-storage and forced to re-sign.
    // `available: false` (a successful response) means safeStorage genuinely
    // isn't supported (e.g. Linux without a keyring) → fall through to session.
    let backendReachable = false

    try {
      const { available, value } = await serverApi.readIdentityCache()
      backendReachable = true

      if (available) {
        const parsed = parsePersisted(value)

        if (parsed) {
          try {
            const signer = createSignerFromSecret(parsed.signatureHex)
            set({
              signer,
              walletAddress: parsed.walletAddress,
              swarmIdAccount: parsed.sid ? { address: parsed.sid, name: parsed.sidName ?? '' } : null,
              hydrated: true,
              backend: 'safe-storage',
            })

            return true
          } catch {
            // Corrupt cache; clear and continue
            await serverApi.clearIdentityCache().catch(() => undefined)
          }
        }
        set({ hydrated: true, backend: 'safe-storage' })

        return true
      }
    } catch {
      // backend unreachable — transient; signal the caller to retry.
      return false
    }

    // safeStorage genuinely unavailable → fall back to sessionStorage.
    const persisted = readSession()

    if (persisted) {
      try {
        const signer = createSignerFromSecret(persisted.signatureHex)
        set({
          signer,
          walletAddress: persisted.walletAddress,
          swarmIdAccount: persisted.sid ? { address: persisted.sid, name: persisted.sidName ?? '' } : null,
          hydrated: true,
          backend: 'session-storage',
        })

        return true
      } catch {
        clearSession()
      }
    }
    set({ hydrated: true, backend: 'session-storage' })

    return backendReachable
  },

  setSigner: async (signatureHex, walletAddress, account) => {
    const signer = createSignerFromSecret(signatureHex)
    set({ signer, walletAddress, swarmIdAccount: account ?? null, deriving: false, error: null })

    const persisted: PersistedShape = account
      ? { signatureHex, walletAddress, sid: account.address, sidName: account.name }
      : { signatureHex, walletAddress }

    // Try safeStorage; fall back to sessionStorage if unavailable or call fails
    try {
      const result = await serverApi.writeIdentityCache(JSON.stringify(persisted))

      if (result.stored) {
        set({ backend: 'safe-storage' })

        return
      }
    } catch {
      // fall through
    }
    writeSession(persisted)
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
    set({ signer: null, walletAddress: null, swarmIdAccount: null, deriving: false, error: null })
  },
}))
