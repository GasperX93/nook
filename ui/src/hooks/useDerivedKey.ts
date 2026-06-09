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
import { getAccount } from '@wagmi/core'
import { useCallback, useEffect, useRef } from 'react'
import { useAccount, useSignMessage } from 'wagmi'

import { SIGN_MESSAGE } from '../crypto/signer'
import { setActiveIdentity } from '../notify/active-identity'
import { useIdentityStore } from '../store/identity'
import { wagmiConfig } from '../wagmi'

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

  // Hydrate the identity store from safeStorage on first mount. hydrate()
  // returns false on a transient failure (Koa not up yet at boot); retry a
  // bounded number of times so a valid safeStorage cache isn't permanently
  // downgraded to session-storage and the user isn't forced to re-sign (D8).
  useEffect(() => {
    let cancelled = false
    let attempts = 0
    const MAX_ATTEMPTS = 5
    const RETRY_MS = 1000

    const tryHydrate = async () => {
      if (cancelled) return
      attempts += 1
      const ok = await hydrate()

      if (!ok && !cancelled && attempts < MAX_ATTEMPTS) {
        setTimeout(() => void tryHydrate(), RETRY_MS)
      }
    }

    void tryHydrate()

    return () => {
      cancelled = true
    }
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

    // Security (D6): wipe a hydrated/foreign identity as soon as a mismatch is
    // *confirmed* — both the cached walletAddress and the connected address are
    // known and differ. Not gated on status==='connected', because hydrate()
    // (which has no access to the wagmi address) can set a signer from a
    // different wallet's cache during the 'connecting'/'reconnecting' boot
    // window. We only clear on a confirmed mismatch, never when `address` is
    // merely not-yet-known.
    if (walletAddress && address && walletAddress.toLowerCase() !== address.toLowerCase()) {
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

        // Security (D7): the user can switch wallets in MetaMask while the
        // signature popups are pending. `address` is captured from the closure
        // at call time, so persisting against it would bind a signature from
        // the NEW wallet to the OLD address. Re-read the live connected address
        // and bail if it changed — the switch effect will derive for the new
        // wallet on its own.
        const currentAddress = getAccount(wagmiConfig).address

        if (!currentAddress || currentAddress.toLowerCase() !== address.toLowerCase()) {
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

  // Security (D6): only ever expose a signer that matches the currently
  // connected wallet. hydrate() can momentarily set a signer from a previous
  // wallet's cache before the clear effect above runs; gating the *returned*
  // value on an address match guarantees no consumer can perform feed/ACT
  // operations under a stale identity, independent of effect timing.
  const signerMatchesWallet = Boolean(
    signer && walletAddress && address && walletAddress.toLowerCase() === address.toLowerCase(),
  )
  const safeSigner = signerMatchesWallet ? signer : null

  // Phase 4: keep the per-identity storage namespace in sync with the derived
  // identity. Contacts/messages/invitations/display-name are keyed by this
  // address, so different wallets see different data. null when no safe signer
  // (disconnected / mismatched / mid-boot) → reads/writes hit the isolated
  // ':__none__' bucket and no wallet's data leaks across the gap.
  const safeAddress = safeSigner ? safeSigner.getAddress() : null

  useEffect(() => {
    setActiveIdentity(safeAddress)
  }, [safeAddress])

  return {
    /** The derived signer for the connected wallet, or null if not yet derived / mismatched */
    signer: safeSigner,

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
