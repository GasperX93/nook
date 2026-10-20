import { Bee } from '@ethersphere/bee-js'
import { identity } from '@swarm-notify/sdk'
import { useEffect } from 'react'

import { useAddresses, useReclaimableDrives, useStamps } from '../api/queries'
import { useDerivedKey } from './useDerivedKey'
import { pickMessagingStamp } from '../lib/system-stamp'
import { getPublishConsent } from '../lib/publish-consent'
import { publishIdentity, restampIdentity } from '../notify/publish-identity'
import { getIdentityStamp, isIdentityPublished, setIdentityStamp } from '../notify/storage'

/**
 * Auto-publish (#130/#131): the missing wire between "identity created" and
 * "identity findable". Publishing needs network space, which doesn't exist at
 * identity-creation time — so onboarding collects consent and THIS hook
 * completes the publish as soon as a signer, consent, and a usable batch
 * (preferably the reserved space) coexist. Idempotent via the same
 * isIdentityPublished marker the manual button uses; re-publish stays manual.
 *
 * Key-drift healing (#11 test-run finding): a reinstall regenerates the Bee
 * node key while the wallet-derived address (and its published identity)
 * survives — so lookups hand out a dead sharing key and every drive share
 * fails. Once per session, compare the network's view of our identity with
 * the current node key and republish on mismatch (the SDK's forward-probe
 * feed makes updates actually take effect; an unchanged identity is a no-op).
 *
 * Reserve replacement: when the reserved space in use isn't the batch the
 * identity was last stored with (a new reserve, or the identity went out on a
 * drive while there was none), store it again with the reserve — otherwise
 * it disappears from the network when the old batch runs out.
 */

let inFlight = false
let driftChecked = false
/** A failed re-store waits this long, not just until the next stamps refetch. */
const RESTAMP_RETRY_MS = 10 * 60_000
let restampFailedAt = 0

const BEE_URL = `${window.location.origin}/bee-api`

export function useAutoPublish(): void {
  const { signer } = useDerivedKey()
  const { data: addresses } = useAddresses()
  const { data: stamps } = useStamps()
  const { data: reclaimable } = useReclaimableDrives()

  useEffect(() => {
    if (!signer || !addresses || inFlight) return

    if (!getPublishConsent()) return

    const address = signer.getAddress()
    const published = isIdentityPublished(address)
    const pick = pickMessagingStamp(stamps, new Set((reclaimable ?? []).map(d => d.batchId)))

    if (!pick) return
    const restamp =
      published &&
      !pick.degraded &&
      getIdentityStamp(address) !== pick.batchID.toLowerCase() &&
      Date.now() - restampFailedAt >= RESTAMP_RETRY_MS

    if (published && driftChecked && !restamp) return
    inFlight = true
    const bee = new Bee(BEE_URL)

    const run = async () => {
      if (restamp) {
        try {
          await restampIdentity(bee, signer, pick.batchID)
        } catch (error) {
          restampFailedAt = Date.now()
          throw error
        }
        setIdentityStamp(address, pick.batchID)
      }

      if (published) {
        if (driftChecked) return
        // Session-once drift check. Mark BEFORE resolving so a slow/failed
        // walk doesn't re-trigger on every stamps refetch.
        driftChecked = true
        const onNetwork = await identity.resolve(bee, signer.getAddress())

        if (onNetwork && onNetwork.beePublicKey === addresses.publicKey) return
        // Mismatch (stale key on the network) or unresolvable — republish
        // with the current node key. The SDK probes forward and only writes
        // when the payload actually changed.
      }
      await publishIdentity(bee, signer, pick.batchID, addresses.publicKey)
      setIdentityStamp(address, pick.batchID)
    }

    run()
      .catch(() => {
        // Transient (node warming up, stamp still confirming) — the effect
        // retries on the next stamps/signer update; the manual button remains
        // the explicit fallback.
      })
      .finally(() => {
        inFlight = false
      })
  }, [signer, addresses, stamps, reclaimable])
}
