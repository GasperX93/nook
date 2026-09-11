/**
 * Background outbox drain (#117) — runs at the Layout level so queued sends
 * deliver whichever page is open. This is what turns "quit right after send"
 * from silent loss into delivery on the next launch: the outbox holds the
 * intent, this hook pushes it out as soon as the node can.
 *
 * Same shape as useInboxPolling: side-effect only, per-identity stores.
 */
import { Bee } from '@ethersphere/bee-js'
import { useEffect, useMemo } from 'react'

import { useStamps } from '../api/queries'
import { drainOutbox } from '../notify/deliver'
import { useDerivedKey } from './useDerivedKey'

const BEE_URL = `${window.location.origin}/bee-api`
const DRAIN_INTERVAL_MS = 30_000

export function useOutboxDrain(): void {
  const { signer } = useDerivedKey()
  const { data: stamps } = useStamps()
  const bee = useMemo(() => new Bee(BEE_URL), [])
  const stampId = (stamps ?? []).find(s => s.usable)?.batchID ?? ''

  useEffect(() => {
    // No signer (wallet not derived) or no usable stamp — entries wait in the
    // outbox; nothing is lost, this effect re-runs when either arrives.
    if (!signer || !stampId) return

    let cancelled = false

    const drain = () => {
      if (!cancelled) void drainOutbox(bee, signer, stampId)
    }

    drain()
    const id = setInterval(drain, DRAIN_INTERVAL_MS)

    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [signer, stampId, bee])
}
