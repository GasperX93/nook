/**
 * useDerivedKey — wallet-derived identity, auto-set up on connect.
 *
 * On first wallet connect (or app launch with a connected wallet), we
 * hydrate from the persistent identity cache (Electron safeStorage). If
 * nothing is cached for the connected wallet, we prompt the user once via
 * signMessage and persist. Subsequent launches with the same wallet skip
 * the prompt entirely.
 *
 * If the user rejects the auto-sign prompt, we stay in an "auto-derive
 * declined" state for this session so we don't pester them — they can
 * manually call derive() from the Identity UI to retry.
 *
 * Clears on wallet disconnect or wallet switch.
 */
import { useCallback, useEffect, useRef } from 'react'
import { useAccount, useSignMessage } from 'wagmi'

import { SIGN_MESSAGE } from '../crypto/signer'
import { useIdentityStore } from '../store/identity'

export function useDerivedKey() {
  const { address, isConnected, status } = useAccount()
  const { signMessageAsync } = useSignMessage()
  const {
    signer,
    deriving,
    error,
    walletAddress,
    hydrated,
    setSigner,
    setDeriving,
    setError,
    clear,
    hydrate,
  } = useIdentityStore()

  // Track that the user declined the auto-derive popup so we don't loop on it.
  const declinedThisSession = useRef(false)

  // Hydrate the identity store from safeStorage on first mount (cheap, idempotent).
  useEffect(() => {
    void hydrate()
  }, [hydrate])

  // Clear signer when wallet disconnects or switches to a different address.
  // Only treat 'disconnected' as terminal — during 'connecting' / 'reconnecting'
  // wagmi briefly reports !isConnected on page load.
  useEffect(() => {
    if (status === 'disconnected') {
      if (signer) void clear()
      declinedThisSession.current = false

      return
    }

    if (status === 'connected' && walletAddress && address && walletAddress.toLowerCase() !== address.toLowerCase()) {
      void clear()
      declinedThisSession.current = false
    }
  }, [status, address, walletAddress, signer, clear])

  const derive = useCallback(
    async (opts?: { auto?: boolean }) => {
      // Already derived for this wallet
      if (signer && walletAddress?.toLowerCase() === address?.toLowerCase()) {
        return signer
      }

      if (!isConnected || !address) {
        if (!opts?.auto) setError('Wallet not connected')

        return null
      }

      setDeriving(true)
      setError(null)

      try {
        const signature1 = await signMessageAsync({ message: SIGN_MESSAGE })
        const signature2 = await signMessageAsync({ message: SIGN_MESSAGE })

        if (signature1 !== signature2) {
          setError(
            'Your wallet produced different signatures for the same message. ' +
              'Encryption features cannot work reliably with this wallet. ' +
              'Try using MetaMask or another software wallet.',
          )

          return null
        }

        await setSigner(signature1, address)

        return useIdentityStore.getState().signer
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : 'Signature rejected'

        // User rejected the popup — record it so the auto-derive effect
        // doesn't immediately prompt them again on the next render.
        if (opts?.auto) {
          declinedThisSession.current = true
          // Soft message; the Identity tab CTA is the recovery path.
          setError(null)
        } else {
          setError(msg)
        }

        return null
      } finally {
        setDeriving(false)
      }
    },
    [signer, walletAddress, address, isConnected, signMessageAsync, setSigner, setDeriving, setError],
  )

  // Auto-derive on wallet connect if we don't already have a signer cached.
  useEffect(() => {
    if (!hydrated) return
    if (status !== 'connected' || !address) return
    if (signer) return
    if (deriving) return
    if (declinedThisSession.current) return
    void derive({ auto: true })
  }, [hydrated, status, address, signer, deriving, derive])

  return {
    /** The derived signer, or null if not yet derived */
    signer,

    /** True while waiting for user to approve signature */
    deriving,

    /** Error message if derivation failed */
    error,

    /** Whether a wallet is connected (prerequisite for derivation) */
    walletConnected: isConnected,

    /** Manually trigger the signMessage popup (used by the Identity CTA after a user-declined auto-derive). */
    derive: () => derive(),

    /** Clear the derived key manually */
    clear,
  }
}
