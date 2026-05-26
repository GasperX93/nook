/**
 * useDerivedKey — on-demand wallet key derivation hook.
 *
 * Does NOT derive on wallet connect (users connect for multichain top-up too).
 * Only derives when `derive()` is called (e.g., when user enables encryption).
 * Caches the wallet signature in the identity store (sessionStorage-backed)
 * so refresh does not require re-signing.
 * Clears on wallet disconnect or wallet switch.
 */
import { useCallback, useEffect } from 'react'
import { useAccount, useSignMessage } from 'wagmi'

import { SIGN_MESSAGE } from '../crypto/signer'
import { useIdentityStore } from '../store/identity'

export function useDerivedKey() {
  const { address, isConnected } = useAccount()
  const { signMessageAsync } = useSignMessage()
  const { signer, deriving, error, walletAddress, setSigner, setDeriving, setError, clear } = useIdentityStore()

  // Clear signer when wallet disconnects or switches to a different address
  useEffect(() => {
    if (!isConnected) {
      if (signer) clear()

      return
    }

    if (walletAddress && address && walletAddress.toLowerCase() !== address.toLowerCase()) {
      clear()
    }
  }, [isConnected, address, walletAddress, signer, clear])

  const derive = useCallback(async () => {
    // Already derived for this wallet
    if (signer && walletAddress?.toLowerCase() === address?.toLowerCase()) {
      return signer
    }

    if (!isConnected || !address) {
      setError('Wallet not connected')

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

      setSigner(signature1, address)

      // setSigner reconstructs the signer; read it back from the store.
      return useIdentityStore.getState().signer
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Signature rejected'

      setError(msg)

      return null
    }
  }, [signer, walletAddress, address, isConnected, signMessageAsync, setSigner, setDeriving, setError])

  return {
    /** The derived signer, or null if not yet derived */
    signer,

    /** True while waiting for user to approve signature */
    deriving,

    /** Error message if derivation failed */
    error,

    /** Whether a wallet is connected (prerequisite for derivation) */
    walletConnected: isConnected,

    /** Call this to trigger key derivation (shows MetaMask sign prompt) */
    derive,

    /** Clear the derived key manually */
    clear,
  }
}
