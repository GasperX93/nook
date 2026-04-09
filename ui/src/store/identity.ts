/**
 * Identity store — holds the wallet-derived signer in memory.
 *
 * NEVER persisted to localStorage or disk. Key is re-derived from
 * wallet signature on each session.
 */
import { create } from 'zustand'

import type { NookSigner } from '../crypto/signer'

interface IdentityState {
  /** The derived signer, or null if not yet derived */
  signer: NookSigner | null

  /** True while waiting for user to approve the signature */
  deriving: boolean

  /** Error message if derivation failed */
  error: string | null

  /** Wallet address that produced this signer (to detect wallet switches) */
  walletAddress: string | null

  setSigner: (signer: NookSigner, walletAddress: string) => void
  setDeriving: (deriving: boolean) => void
  setError: (error: string | null) => void
  clear: () => void
}

export const useIdentityStore = create<IdentityState>()(set => ({
  signer: null,
  deriving: false,
  error: null,
  walletAddress: null,

  setSigner: (signer, walletAddress) => set({ signer, walletAddress, deriving: false, error: null }),
  setDeriving: deriving => set({ deriving }),
  setError: error => set({ error, deriving: false }),
  clear: () => set({ signer: null, walletAddress: null, deriving: false, error: null }),
}))
