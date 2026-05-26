/**
 * Identity store — holds the wallet-derived signer.
 *
 * Persisted to sessionStorage (cleared on window close, wallet disconnect,
 * or wallet address switch). What we cache is the raw wallet signature;
 * the signer object is reconstructed via createWalletSigner on hydration.
 * Never persisted to localStorage or disk.
 */
import { create } from 'zustand'

import { createWalletSigner, type NookSigner } from '../crypto/signer'

const SESSION_STORAGE_KEY = 'nook.derivedKey.v1'

interface PersistedShape {
  signatureHex: string
  walletAddress: string
}

function readPersisted(): PersistedShape | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.sessionStorage.getItem(SESSION_STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as PersistedShape
    if (typeof parsed.signatureHex !== 'string' || typeof parsed.walletAddress !== 'string') return null

    return parsed
  } catch {
    return null
  }
}

function writePersisted(value: PersistedShape): void {
  if (typeof window === 'undefined') return
  try {
    window.sessionStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(value))
  } catch {
    // sessionStorage may be unavailable (private mode, quota); fail silently
  }
}

function clearPersisted(): void {
  if (typeof window === 'undefined') return
  try {
    window.sessionStorage.removeItem(SESSION_STORAGE_KEY)
  } catch {
    // ignore
  }
}

interface IdentityState {
  signer: NookSigner | null
  deriving: boolean
  error: string | null
  /** Wallet address that produced this signer (to detect wallet switches) */
  walletAddress: string | null

  /** Store the raw signature; signer is reconstructed and the value is persisted to sessionStorage. */
  setSigner: (signatureHex: string, walletAddress: string) => void
  setDeriving: (deriving: boolean) => void
  setError: (error: string | null) => void
  clear: () => void
}

function hydrate(): Pick<IdentityState, 'signer' | 'walletAddress'> {
  const persisted = readPersisted()
  if (!persisted) return { signer: null, walletAddress: null }
  try {
    return { signer: createWalletSigner(persisted.signatureHex), walletAddress: persisted.walletAddress }
  } catch {
    clearPersisted()

    return { signer: null, walletAddress: null }
  }
}

export const useIdentityStore = create<IdentityState>()(set => ({
  ...hydrate(),
  deriving: false,
  error: null,

  setSigner: (signatureHex, walletAddress) => {
    const signer = createWalletSigner(signatureHex)
    writePersisted({ signatureHex, walletAddress })
    set({ signer, walletAddress, deriving: false, error: null })
  },
  setDeriving: deriving => set({ deriving }),
  setError: error => set({ error, deriving: false }),
  clear: () => {
    clearPersisted()
    set({ signer: null, walletAddress: null, deriving: false, error: null })
  },
}))
