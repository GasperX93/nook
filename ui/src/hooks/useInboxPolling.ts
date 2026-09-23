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

import { playCricketChirp } from '../lib/cricket'
import { appendReceived, loadThreads } from '../notify/messages'
import { getReadCursor, recordRead } from '../notify/receive-cursor'
import { loadContacts } from '../notify/storage'
import { toLibraryContact } from '../notify/types'
import { useAppStore } from '../store/app'
import { useDerivedKey } from './useDerivedKey'

const BEE_URL = `${window.location.origin}/bee-api`
const POLL_INTERVAL_MS = 30_000
/**
 * Probing past the tail costs a 404 per slot on every contact, every poll.
 * The full look-ahead (hops a sender's slot-gap) runs on the first poll and
 * then every Nth; the polls between stop at the first missing slot — a rare
 * gap delays later messages by at most one full cycle (~5 min). R3b-2.
 */
const FULL_LOOKAHEAD_EVERY = 10

export function useInboxPolling(): void {
  const { signer } = useDerivedKey()
  const bee = useMemo(() => new Bee(BEE_URL), [])

  useEffect(() => {
    if (!signer) return

    let cancelled = false
    let pollCount = 0
    // Sequential reads can outlast the interval (first full read of long
    // histories) — never run two polls at once.
    let polling = false

    const poll = async () => {
      if (polling) return
      polling = true
      const fullLookahead = pollCount % FULL_LOOKAHEAD_EVERY === 0

      pollCount++
      const myAddr = signer.getAddress()
      // Re-read contacts each tick — the user may add a contact between polls.
      // Filter out self: if a user adds their own share link as a contact (eg
      // for solo testing), every poll otherwise hits myAddr→myAddr (404).
      const contacts = loadContacts().filter(c => c.id.toLowerCase() !== myAddr.toLowerCase())

      if (contacts.length === 0) {
        polling = false

        return
      }

      try {
        // One contact at a time from its read cursor (R3b-2): the old
        // checkInbox walked every full history in parallel each tick.
        let newCount = 0

        for (const contact of contacts) {
          if (cancelled) return
          const lib = toLibraryContact(contact)
          const { fromIndex, retryIndices } = getReadCursor(contact.id)

          try {
            const result = await mailbox.readMailbox(bee, signer.getSigningKey(), myAddr, lib, {
              fromIndex,
              retryIndices,
              lookahead: fullLookahead ? undefined : 0,
            })

            if (cancelled) return
            recordRead(contact.id, result)
            // Fresh load right before the write: a message sent while this
            // (possibly long) poll ran must not be overwritten by a snapshot.
            const current = loadThreads()
            const key = lib.ethAddress.toLowerCase()
            const before = current[key]?.length ?? 0
            const after = appendReceived(current, lib.ethAddress, result.messages)[key]?.length ?? 0

            newCount += Math.max(0, after - before)
          } catch {
            // One unreachable mailbox must not stop the others; the cursor is
            // unchanged, so the next tick retries from the same place.
          }
        }

        // Chirp on new arrivals — only if enabled AND the user isn't already
        // looking at a page that shows the messages. Threads render on both the
        // Contacts page and the Messages app (#/apps/messages), so suppress on
        // either (D12) — otherwise it chirps while you're reading the thread.
        if (newCount > 0 && useAppStore.getState().notificationSound) {
          const hash = window.location.hash
          const viewingMessages = hash.startsWith('#/contacts') || hash.startsWith('#/apps/messages')

          if (document.hidden || !viewingMessages) playCricketChirp()
        }
      } catch {
        // Network blips happen; the next tick will retry. Don't spam the UI.
      } finally {
        polling = false
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
