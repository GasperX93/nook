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
import { type Contact, mailbox } from '@swarm-notify/sdk'
import { useEffect, useMemo, useRef } from 'react'

import { playCricketChirp } from '../lib/cricket'
import { CONTACTS_RESTORED_EVENT } from '../notify/backup-signal'
import {
  advanceSendCursor,
  appendReceived,
  conversationPending,
  getSentSeen,
  loadThreads,
  markSentLoaded,
  markSentSeen,
  mergeSentFromFeed,
  needsSentLoad,
  sentReadComplete,
} from '../notify/messages'
import { applyDriveMessages } from '../notify/drive-access'
import { getOpenContact, OPEN_CONTACT_EVENT } from '../notify/open-contact'
import { getReadCursor, recordRead } from '../notify/receive-cursor'
import { loadContacts } from '../notify/storage'
import { toLibraryContact } from '../notify/types'
import { useAppStore } from '../store/app'
import { useDerivedKey } from './useDerivedKey'

const BEE_URL = `${window.location.origin}/bee-api`
const POLL_INTERVAL_MS = 30_000
/** While a conversation is still loading (#191), the next poll comes this soon… */
const QUICK_POLL_MS = 5_000
/** …but only this long after the poller started, so an unreadable feed can't keep it fast. */
const QUICK_POLL_FOR_MS = 180_000
/**
 * Probing past the tail costs a 404 per slot on every contact, every poll.
 * The full look-ahead (hops a sender's slot-gap) runs on the first poll and
 * then every Nth; the polls between stop at the first missing slot — a rare
 * gap delays later messages by at most one full cycle (~5 min). R3b-2.
 */
const FULL_LOOKAHEAD_EVERY = 10

/**
 * My own feed to a contact (#191). In a browser that shows none of my sent
 * messages yet (another browser, cleared data) it is read from the start, all
 * or nothing: a short read (the node can't find the feed yet, right after
 * start) keeps nothing and is tried again next poll. After that each poll
 * reads on from where this browser got to, so what I send from another
 * browser, a private window or dev mode shows up here too.
 */
async function readMySent(
  bee: Bee,
  key: Uint8Array,
  myAddr: string,
  contact: Contact,
  fullLookahead: boolean,
): Promise<void> {
  const first = needsSentLoad(contact.ethAddress)
  const seen = first ? undefined : getSentSeen(contact.ethAddress)
  const sent = await mailbox.readMailbox(bee, key, myAddr, contact, {
    direction: 'sent',
    fromIndex: seen ?? 0,
    // A first read hops gaps in the feed; later ones mostly stop at the end.
    lookahead: seen === undefined || fullLookahead ? undefined : 0,
  })

  if (first && !sentReadComplete(contact.ethAddress, sent.nextIndex)) return
  mergeSentFromFeed(loadThreads(), contact.ethAddress, sent.messages)

  if (sent.nextIndex > 0) advanceSendCursor(contact.ethAddress, sent.nextIndex - 1)
  markSentSeen(contact.ethAddress, sent.nextIndex)

  if (first) markSentLoaded(contact.ethAddress)
}

export function useInboxPolling(): void {
  const { signer } = useDerivedKey()
  const bee = useMemo(() => new Bee(BEE_URL), [])
  // Restart only when the identity changes, not for every new signer object
  // of the same identity (the store makes several at boot) — a restart drops
  // a long first read (#191) before it is recorded.
  const signerRef = useRef(signer)

  signerRef.current = signer
  const address = signer?.getAddress() ?? null

  useEffect(() => {
    const signer = signerRef.current

    if (!address || !signer) return

    let cancelled = false
    let pollCount = 0
    // Sequential reads can outlast the interval (first full read of long
    // histories) — never run two polls at once.
    let polling = false
    // A poll asked for while one runs (contacts just restored) runs right after it.
    let pollAgain = false

    const poll = async () => {
      if (polling) {
        pollAgain = true

        return
      }
      polling = true
      pollAgain = false
      const fullLookahead = pollCount % FULL_LOOKAHEAD_EVERY === 0

      pollCount++
      const myAddr = signer.getAddress()
      // Re-read contacts each tick — the user may add a contact between polls.
      // Filter out self: if a user adds their own share link as a contact (eg
      // for solo testing), every poll otherwise hits myAddr→myAddr (404).
      const open = getOpenContact()
      // The conversation on screen first — its first read shouldn't wait for the others.
      const contacts = loadContacts()
        .filter(c => c.id.toLowerCase() !== myAddr.toLowerCase())
        .sort((a, b) => Number(b.id.toLowerCase() === open) - Number(a.id.toLowerCase() === open))

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
            // My own feed failing must not hold up their messages.
            await readMySent(bee, signer.getSigningKey(), myAddr, lib, fullLookahead).catch(() => undefined)

            if (cancelled) return
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
            const known = new Set((current[key] ?? []).map(m => m.id))
            const thread = appendReceived(current, lib.ethAddress, result.messages)[key] ?? []
            const added = thread.filter(m => !known.has(m.id))

            newCount += added.length
            // Access removed / restored reaches "Shared with me" right away (R4-15).
            applyDriveMessages(added, contact.nickname)
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

        if (pollAgain && !cancelled) void poll()
        else if (!cancelled) scheduleQuickPoll()
      }
    }

    let startedAt = Date.now()
    let quickTimer: ReturnType<typeof setTimeout> | null = null
    // A conversation still loading in this browser: try again in seconds, not 30 s.
    const scheduleQuickPoll = () => {
      if (quickTimer || Date.now() - startedAt > QUICK_POLL_FOR_MS) return

      if (!loadContacts().some(c => conversationPending(c.id))) return
      quickTimer = setTimeout(() => {
        quickTimer = null
        void poll()
      }, QUICK_POLL_MS)
    }

    const pollNow = () => void poll()

    void poll()
    const id = setInterval(pollNow, POLL_INTERVAL_MS)

    // Contacts restored from the app folder (#192): read them now, not in 30 s.
    window.addEventListener(CONTACTS_RESTORED_EVENT, pollNow)
    // A conversation just opened: read it now (it goes first), and quickly again while it loads.
    const pollOpened = () => {
      startedAt = Date.now()
      void poll()
    }

    window.addEventListener(OPEN_CONTACT_EVENT, pollOpened)

    return () => {
      cancelled = true
      clearInterval(id)

      if (quickTimer) clearTimeout(quickTimer)
      window.removeEventListener(CONTACTS_RESTORED_EVENT, pollNow)
      window.removeEventListener(OPEN_CONTACT_EVENT, pollOpened)
    }
  }, [address, bee])
}
