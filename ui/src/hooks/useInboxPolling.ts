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

import { api } from '../api/client'
import { playCricketChirp } from '../lib/cricket'
import { CONTACTS_RESTORED_EVENT } from '../notify/backup-signal'
import {
  advanceSendCursor,
  appendReceived,
  conversationPending,
  loadThreads,
  markSentLoaded,
  mergeSentFromFeed,
  needsSentLoad,
  sentReadComplete,
  type StoredMessage,
} from '../notify/messages'
import { applyDriveMessages } from '../notify/drive-access'
import { getOpenContact, OPEN_CONTACT_EVENT } from '../notify/open-contact'
import {
  expectedPosition,
  getReadCursor,
  getSentCursor,
  hasReadCursor,
  readPosition,
  recordRead,
  recordSentRead,
} from '../notify/receive-cursor'
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
 * A first read of my feed that keeps falling short of my send cursor (a slot
 * of mine the node never manages to fetch) is taken as it is after this many tries, and later
 * reads go on from where it stopped — instead of re-reading the whole feed
 * every poll forever.
 */
const FIRST_SENT_READ_TRIES = 10
const firstSentReadTries = new Map<string, number>()

/**
 * My own feed to a contact (#191). In a browser that shows none of my sent
 * messages yet (another browser, cleared data) it is read from the start, all
 * or nothing: a read that stops early or short of my send cursor (the node
 * can't fetch the feed yet, right after start) keeps nothing and is tried
 * again next poll. After that each poll reads on from where this browser got
 * to, so what I send from another browser, a private window or dev mode shows
 * up here too; messages are recognised by feed index, so none shows twice.
 */
async function readMySent(
  bee: Bee,
  key: Uint8Array,
  myAddr: string,
  contact: Contact,
  fullLookahead: boolean,
): Promise<void> {
  const id = contact.ethAddress
  const first = needsSentLoad(id)
  const cursor = first ? undefined : getSentCursor(id)
  const sent = await mailbox.readMailbox(bee, key, myAddr, contact, {
    direction: 'sent',
    fromIndex: cursor?.fromIndex ?? 0,
    retryIndices: cursor?.retryIndices,
    // A first read hops gaps in the feed; later ones mostly stop at the end.
    lookahead: cursor === undefined || fullLookahead ? undefined : 0,
  })

  if (first && !sentReadComplete(id, sent.nextIndex)) {
    const tries = (firstSentReadTries.get(id) ?? 0) + 1

    firstSentReadTries.set(id, tries)

    if (tries < FIRST_SENT_READ_TRIES) return
  }
  mergeSentFromFeed(loadThreads(), id, sent.messages, sent.indexes)

  if (sent.nextIndex > 0) advanceSendCursor(id, sent.nextIndex - 1)
  recordSentRead(id, sent, cursor?.retryIndices ?? [])

  if (first) markSentLoaded(id)
}

/**
 * Their feed to me, from this browser's read cursor. While this browser is
 * behind where one of mine had read (a new browser, #191) every read hops
 * gaps, so it doesn't wait for the periodic full look-ahead to catch up.
 * Returns the messages that are new here.
 */
async function readTheirs(
  bee: Bee,
  key: Uint8Array,
  myAddr: string,
  contact: Contact,
  fullLookahead: boolean,
): Promise<StoredMessage[]> {
  const id = contact.ethAddress
  const { fromIndex, retryIndices } = getReadCursor(id)
  const catchingUp = !hasReadCursor(id) || readPosition(id) < expectedPosition(id)
  const result = await mailbox.readMailbox(bee, key, myAddr, contact, {
    fromIndex,
    retryIndices,
    lookahead: fullLookahead || catchingUp ? undefined : 0,
  })

  recordRead(id, result, retryIndices)
  const messages = result.messages
  // Fresh load right before the write: a message sent while this
  // (possibly long) poll ran must not be overwritten by a snapshot.
  const current = loadThreads()
  const threadKey = id.toLowerCase()
  const known = new Set((current[threadKey] ?? []).map(m => m.id))
  const thread = appendReceived(current, id, messages)[threadKey] ?? []

  return thread.filter(m => !known.has(m.id))
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

    // `quick`: a retry while a conversation is still loading — only those are read.
    const poll = async (quick = false) => {
      if (polling) {
        if (!quick) pollAgain = true

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
      const contacts = loadContacts()
        .filter(c => c.id.toLowerCase() !== myAddr.toLowerCase())
        .filter(c => !quick || conversationPending(c.id))

      if (contacts.length === 0) {
        polling = false

        return
      }

      try {
        // Bee down or restarting: every read would stop early (the proxy answers
        // 502), and nothing read now must move a cursor. Skip the round.
        if (
          !(await api
            .getBeeReadiness()
            .then(r => r.ready)
            .catch(() => false))
        ) {
          return
        }

        // One contact at a time from its read cursor (R3b-2): the old
        // checkInbox walked every full history in parallel each tick.
        let newCount = 0

        const queue = [...contacts]

        while (queue.length > 0) {
          if (cancelled) return
          // The conversation on screen next — also when it was opened while this
          // round was already running, so its first read doesn't wait for the rest.
          const open = getOpenContact()
          const at = queue.findIndex(c => c.id.toLowerCase() === open)
          const [contact] = queue.splice(Math.max(at, 0), 1)
          const lib = toLibraryContact(contact)

          try {
            // My own feed failing must not hold up their messages.
            await readMySent(bee, signer.getSigningKey(), myAddr, lib, fullLookahead).catch(() => undefined)

            if (cancelled) return
            const added = await readTheirs(bee, signer.getSigningKey(), myAddr, lib, fullLookahead)

            if (cancelled) return
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
        void poll(true)
      }, QUICK_POLL_MS)
    }

    const pollNow = () => void poll()

    void poll()
    const id = setInterval(pollNow, POLL_INTERVAL_MS)

    // Contacts restored from the app folder (#192): read them now, not in 30 s.
    window.addEventListener(CONTACTS_RESTORED_EVENT, pollNow)
    // A conversation just opened: read it now (it goes first), and quickly again while it loads.
    // Only a still-loading conversation needs reading; a running round picks it next.
    const pollOpened = () => {
      startedAt = Date.now()
      void poll(true)
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
