/**
 * Background inbox polling — runs at the Layout level so messages keep
 * arriving (and the unread badge updates) even when the Messages page
 * isn't mounted.
 *
 * Side-effect only: fetches new messages from each contact's mailbox feed,
 * merges them into the localStorage threads store. Components reading
 * threads from localStorage (Messages page, Layout badge) pick up the
 * changes on their next render or interval tick.
 */
import { Bee } from '@ethersphere/bee-js'
import { mailbox } from '@swarm-notify/sdk'
import { useEffect, useMemo } from 'react'

import { loadThreads, mergeReceived, saveThreads } from '../notify/messages'
import { loadContacts } from '../notify/storage'
import { toLibraryContact } from '../notify/types'
import { useDerivedKey } from './useDerivedKey'

const BEE_URL = `${window.location.origin}/bee-api`
const POLL_INTERVAL_MS = 30_000

export function useInboxPolling(): void {
  const { signer } = useDerivedKey()
  const bee = useMemo(() => new Bee(BEE_URL), [])

  useEffect(() => {
    if (!signer) return

    let cancelled = false

    const poll = async () => {
      const myAddr = signer.getAddress()
      // Re-read contacts each tick — the user may add a contact between polls.
      // Filter out self: if a user adds their own share link as a contact (eg
      // for solo testing), every poll otherwise hits myAddr→myAddr (404).
      const contacts = loadContacts().filter(c => c.id.toLowerCase() !== myAddr.toLowerCase())

      if (contacts.length === 0) return

      try {
        const inbox = await mailbox.checkInbox(bee, signer.getSigningKey(), myAddr, contacts.map(toLibraryContact))

        if (cancelled) return
        // Merge directly into stored threads so the on-disk view is the
        // source of truth for both Messages and the sidebar badge.
        let threads = loadThreads()

        for (const { contact, messages } of inbox) {
          threads = mergeReceived(threads, contact.ethAddress, messages)
        }
        // mergeReceived already persists per call, but call once more here
        // for clarity in case the loop body ever changes.
        saveThreads(threads)
      } catch {
        // Network blips happen; the next tick will retry. Don't spam the UI.
      }
    }

    void poll()
    const id = setInterval(() => void poll(), POLL_INTERVAL_MS)

    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [signer, bee])
}
