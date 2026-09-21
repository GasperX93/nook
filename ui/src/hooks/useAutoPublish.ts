import { Bee } from '@ethersphere/bee-js'
import { identity } from '@swarm-notify/sdk'
import { useEffect } from 'react'

import { useAddresses, useReclaimableDrives, useStamps } from '../api/queries'
import { useDerivedKey } from './useDerivedKey'
import { pickMessagingStamp } from '../lib/system-stamp'
import { getPublishConsent } from '../lib/publish-consent'
import { publishIdentity } from '../notify/publish-identity'
import { isIdentityPublished } from '../notify/storage'

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
 */

let inFlight = false
let driftChecked = false

const BEE_URL = `${window.location.origin}/bee-api`

export function useAutoPublish(): void {
  const { signer } = useDerivedKey()
  const { data: addresses } = useAddresses()
  const { data: stamps } = useStamps()
  const { data: reclaimable } = useReclaimableDrives()

  useEffect(() => {
    if (!signer || !addresses || inFlight) return

    if (!getPublishConsent()) return

    const published = isIdentityPublished(signer.getAddress())

    if (published && driftChecked) return
    const pick = pickMessagingStamp(stamps, new Set((reclaimable ?? []).map(d => d.batchId)))

    if (!pick) return
    inFlight = true
    const bee = new Bee(BEE_URL)

    const run = async () => {
      if (published) {
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
