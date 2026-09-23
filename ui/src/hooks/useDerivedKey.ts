/**
 * useDerivedKey — the Nook identity, seeded by Swarm ID.
 *
 * Signing in with Swarm ID yields a 32-byte app secret (deriveAppSecret) that
 * is the same for this account on every device. It seeds the regular
 * NookSigner chain and is persisted through the identity cache (Electron
 * safeStorage, sessionStorage fallback), so later launches need no sign-in.
 *
 * A wallet is a payment tool only: connecting, switching or disconnecting one
 * never creates, changes or wipes the identity.
 *
 * Installs from before Swarm ID may still hold a wallet-derived identity in
 * the cache. It is never activated; signing in with Swarm ID overwrites it.
 * The UI explains the move via the markers in notify/active-identity (#21).
 */
import { useCallback, useEffect } from 'react'

import { SWARM_ID_SECRET_PREFIX, SWARM_ID_WALLET_MARKER } from '../crypto/signer'
import { markSwarmIdIdentity, setActiveIdentity } from '../notify/active-identity'
import { migrateMessagesToV2 } from '../notify/messages'
import { acquireDeriveLock, releaseDeriveLock, useIdentityStore } from '../store/identity'
import { signInWithSwarmId } from '../swarm-id'

export function useDerivedKey() {
  const { signer, deriving, error, walletAddress, swarmIdAccount, setSigner, setDeriving, setError, clear, hydrate } =
    useIdentityStore()

  // Hydrate the identity store from safeStorage on first mount. hydrate()
  // returns false on a transient failure (Koa not up yet at boot); retry a
  // bounded number of times so a valid safeStorage cache isn't permanently
  // downgraded to session-storage and the user isn't forced to sign in again (D8).
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

  // Sign in with Swarm ID: dialog → SDK popup → deriveAppSecret → the same
  // NookSigner chain, persisted through the same identity cache.
  const signIn = useCallback(async () => {
    // Shared across ALL useDerivedKey instances (several are mounted at once),
    // so only the first caller opens the dialog.
    if (!acquireDeriveLock()) return null
    setDeriving(true)
    setError(null)

    try {
      const { seedHex, identity } = await signInWithSwarmId()

      await setSigner(`${SWARM_ID_SECRET_PREFIX}${seedHex}`, SWARM_ID_WALLET_MARKER, {
        address: identity.address,
        name: identity.name,
      })

      return useIdentityStore.getState().signer
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Swarm ID sign-in failed')

      return null
    } finally {
      releaseDeriveLock()
      setDeriving(false)
    }
  }, [setSigner, setDeriving, setError])

  // Only a Swarm ID-seeded identity is ever exposed. A legacy wallet-derived
  // cache entry stays dormant.
  const safeSigner = signer && walletAddress === SWARM_ID_WALLET_MARKER ? signer : null

  // Keep the per-identity storage namespace in sync. Contacts/messages/
  // invitations/display-name are keyed by this address; null (signed out /
  // mid-boot) → reads/writes hit the isolated ':__none__' bucket.
  const safeAddress = safeSigner ? safeSigner.getAddress() : null

  useEffect(() => {
    // Before setActiveIdentity overwrites the last-identity marker (#21).
    if (safeAddress) markSwarmIdIdentity(safeAddress)
    setActiveIdentity(safeAddress)

    // Once the identity namespace is active, run the one-time v2 clean break
    // (drops stale single-slot v1 threads — see migrateMessagesToV2). Idempotent.
    if (safeAddress) migrateMessagesToV2()
  }, [safeAddress])

  return {
    /** The Nook signer, or null when not signed in with Swarm ID */
    signer: safeSigner,

    /** True while the Swarm ID sign-in is in progress */
    deriving,

    /** Error message if sign-in failed */
    error,

    /** Open the Swarm ID sign-in dialog and derive the Nook identity */
    signIn,

    /** The Swarm ID account signed in (name shown in the UI; its address is display-only) */
    swarmIdAccount: safeSigner ? swarmIdAccount : null,

    /** Wipe the persisted identity (sign-out) */
    clear,
  }
}
