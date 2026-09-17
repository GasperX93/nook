import { Bee } from '@ethersphere/bee-js'
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
 */

let inFlight = false

const BEE_URL = `${window.location.origin}/bee-api`

export function useAutoPublish(): void {
  const { signer } = useDerivedKey()
  const { data: addresses } = useAddresses()
  const { data: stamps } = useStamps()
  const { data: reclaimable } = useReclaimableDrives()

  useEffect(() => {
    if (!signer || !addresses || inFlight) return

    if (!getPublishConsent()) return

    if (isIdentityPublished(signer.getAddress())) return
    const pick = pickMessagingStamp(stamps, new Set((reclaimable ?? []).map(d => d.batchId)))

    if (!pick) return
    inFlight = true
    publishIdentity(new Bee(BEE_URL), signer, pick.batchID, addresses.publicKey)
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
