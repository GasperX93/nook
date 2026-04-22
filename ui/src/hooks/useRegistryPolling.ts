/**
 * Background polling for the on-chain notification registry. Companion to
 * useInboxPolling — surfaces wake-up pings from senders who aren't yet in
 * the local contact list.
 *
 * RPC calls don't cost gas, but they're slower than feed reads. Poll less
 * aggressively than the mailbox.
 */
import { registry } from '@swarm-notify/sdk'
import { useEffect } from 'react'

import { addInvitation, getRegistryCursor, loadInvitations, setRegistryCursor } from '../notify/invitations'
import { REGISTRY_ADDRESS } from '../notify/constants'
import { createNotifyProvider } from '../notify/provider'
import { loadContacts } from '../notify/storage'
import { useDerivedKey } from './useDerivedKey'

const POLL_INTERVAL_MS = 2 * 60_000 // 2 minutes

export function useRegistryPolling(): void {
  const { signer } = useDerivedKey()

  useEffect(() => {
    if (!signer) return

    let cancelled = false
    const provider = createNotifyProvider() // RPC-only, no walletClient needed for reads

    const poll = async () => {
      try {
        const myAddr = signer.getAddress()
        const fromBlock = getRegistryCursor(myAddr)
        const notifications = await registry.pollNotifications(
          provider,
          REGISTRY_ADDRESS,
          myAddr,
          signer.getSigningKey(),
          fromBlock,
        )

        if (cancelled || notifications.length === 0) return

        const contacts = loadContacts()
        const knownAddrs = new Set(contacts.map(c => c.id.toLowerCase()))
        let invitations = loadInvitations()
        let highestBlock = fromBlock

        for (const { payload, blockNumber } of notifications) {
          if (blockNumber > highestBlock) highestBlock = blockNumber

          const senderId = payload.sender.toLowerCase()

          // Skip: already a contact (mailbox poll will deliver their messages)
          if (knownAddrs.has(senderId)) continue
          invitations = addInvitation(invitations, senderId, blockNumber)
        }

        // Advance cursor past the latest block we processed so next poll is incremental
        if (highestBlock > fromBlock) setRegistryCursor(myAddr, highestBlock + 1)
      } catch {
        // Spam decryption-fails are silently ignored by the SDK; other errors
        // (RPC blip, etc) we just retry on next tick.
      }
    }

    void poll()
    const id = setInterval(() => void poll(), POLL_INTERVAL_MS)

    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [signer])
}
