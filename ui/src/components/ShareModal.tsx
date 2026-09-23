/**
 * ShareModal — manage grantees for an encrypted drive.
 * Paste a Nook address or contact link to grant access (raw sharing
 * key still accepted as a fallback). Generates a drive share link.
 */
import { Bee } from '@ethersphere/bee-js'
import { identity, registry } from '@swarm-notify/sdk'
import { Copy, Check, Lock, RefreshCw, Users, X } from 'lucide-react'
import { useEffect, useRef, useMemo, useState } from 'react'

import { topicFromString, waitForRetrievable } from '../api/bee'
import { useWallet } from '../api/queries'
import { serverApi } from '../api/server'
import { bytesToHex, hexToBytes } from '../lib/hex'
import { contactForOldNodeKey, contactsForNodeKey, stripKeyPrefix } from '../lib/node-key'
import { useDerivedKey } from '../hooks/useDerivedKey'
import { REGISTRY_ADDRESS } from '../notify/constants'
import { deriveConnectionState, getMyDisplayName, hasInboundSince } from '../notify/contact-state'
import { queueAndDeliver } from '../notify/deliver'
import { clearRemovedFromDrive, markRemovedFromDrive, wasRemovedFromDrive } from '../notify/drive-removed'
import { loadThreads } from '../notify/messages'
import { createNodeNotifyProvider } from '../notify/provider'
import { decodeShareLink } from '../notify/share-link'
import { addContact, isIdentityPublished, loadContacts, updateContactKeys } from '../notify/storage'
import { type NookContact } from '../notify/types'
import { buildShareLink } from '../hooks/useSharedDrives'
import { Button } from './ui/button'
import { Input } from './ui/input'

const BEE_URL = `${window.location.origin}/bee-api`

interface ShareFileEntry {
  name: string
  reference: string
  historyRef: string
  size: number
}

interface ShareModalProps {
  driveName: string
  stampId: string
  actPublisher?: string
  actHistoryRef?: string
  granteeRef?: string
  /** Node's own publicKey — to show "you" label in grantee list */
  myPublicKey?: string
  /** Bee node's ethereum address — for feed-based share link */
  beeAddress?: string
  /** Files in the drive — used to build the encrypted metadata for sharing */
  files?: ShareFileEntry[]
  onClose: () => void
  onUpdate: (data: { granteeRef: string; historyRef: string; granteeCount: number; keyRotated?: boolean }) => void
  /** True when a revoke rotated the key — existing files need re-publishing. */
  keyRotated?: boolean
  /** Re-publish in progress (owned by the Drive page). */
  republishing?: boolean
  /** Re-publish progress/result message (owned by the Drive page). */
  republishMsg?: string | null
  /** Re-encrypt + re-upload this drive's files under the current key. */
  onRepublish?: () => void
  /** Latest public wrapper ref after a metadata refresh (#93 health checks). */
  onWrapperRef?: (ref: string) => void
  /**
   * Authoritative grantee count (including owner), reported whenever the list
   * is loaded from the node. Self-heals the cached count on the drive card —
   * grant/revoke math can drift when operations race the async list load.
   */
  onGranteeCount?: (n: number) => void
  /**
   * Fire the bulk update-notification automatically once the grantee list is
   * loaded (#135 — the drive's "Notify recipients" prompt lands here so the
   * whole flow is one click, with the per-recipient badges as feedback).
   */
  autoNotify?: boolean
}

function isValidPublicKey(key: string): boolean {
  const clean = key.startsWith('0x') ? key.slice(2) : key

  // Compressed (66 hex = 33 bytes) or uncompressed (130 hex = 65 bytes)
  return /^[0-9a-fA-F]+$/.test(clean) && (clean.length === 66 || clean.length === 130)
}

/** First line only, capped — wallet errors embed full RPC request dumps. */
function shortErrorMessage(e: unknown): string {
  const first = ((e as Error).message ?? 'send failed').split('\n')[0]

  return first.length > 120 ? `${first.slice(0, 120)}…` : first
}

function isEthAddress(s: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(s.trim())
}

export default function ShareModal({
  driveName,
  stampId,
  actPublisher,
  actHistoryRef,
  granteeRef,
  myPublicKey,
  beeAddress,
  files,
  onClose,
  onUpdate,
  keyRotated,
  republishing,
  republishMsg,
  onRepublish,
  onWrapperRef,
  onGranteeCount,
  autoNotify,
}: ShareModalProps) {
  const { signer, swarmIdAccount } = useDerivedKey()
  const { data: nodeWallet } = useWallet()
  // Shown to recipients: the saved display name, else the Swarm ID account name (R4-9).
  const myName = getMyDisplayName() || swarmIdAccount?.name?.trim() || ''
  // State (not useMemo) so it refreshes after a grant adds a new contact —
  // otherwise the just-granted person isn't matched as notifiable.
  const [contacts, setContacts] = useState(() => loadContacts())
  const bee = useMemo(() => new Bee(BEE_URL), [])

  const [newKey, setNewKey] = useState('')
  const [newLabel, setNewLabel] = useState('')
  const [showSuggestions, setShowSuggestions] = useState(false)
  const [grantees, setGrantees] = useState<string[]>([])
  // The one "Share with" field (R4-5): a contact name, Nook address or link.
  const [query, setQuery] = useState('')
  const [showOtherWays, setShowOtherWays] = useState(false)
  // Name of the person just removed — for the amber card (mock A3).
  const [lastRemoved, setLastRemoved] = useState<{ name: string; told: boolean } | null>(null)
  // Per-grantee notification status keyed by lowercased contact id (Nook addr)
  type NotifyStatus = 'idle' | 'sending' | 'sent' | 'queued' | 'failed'
  const [notifyStatus, setNotifyStatus] = useState<Record<string, NotifyStatus>>({})
  const [pingSkippedNote, setPingSkippedNote] = useState<string | null>(null)
  // A grant silently switched to the contact's CURRENT sharing key (their
  // cached one was stale — reinstall). Info, never an error.
  const [keyRefreshNote, setKeyRefreshNote] = useState<string | null>(null)
  // Legacy: older grantees were saved with manual labels before contacts existed.
  // Read-only fallback for displaying their names; new grants pull from contacts.
  const [labels, setLabels] = useState<Record<string, string>>(() => {
    try {
      return JSON.parse(localStorage.getItem('nook-grantee-labels') ?? '{}')
    } catch {
      return {}
    }
  })
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copiedLink, setCopiedLink] = useState(false)
  const [loadedGrantees, setLoadedGrantees] = useState(false)

  function saveLabel(key: string, label: string) {
    const next = { ...labels, [key]: label }
    setLabels(next)
    localStorage.setItem('nook-grantee-labels', JSON.stringify(next))
  }

  /** Find a label for a key — prefers contact list (newest match, #122), falls back to legacy label map. */
  function findLabel(key: string): string | undefined {
    const match = contactsForNodeKey(contacts, key)[0]

    if (match) return match.nickname

    if (labels[key]) return labels[key]
    const keyX = stripKeyPrefix(key)

    for (const [storedKey, label] of Object.entries(labels)) {
      if (stripKeyPrefix(storedKey) === keyX) return label
    }

    return undefined
  }

  /** Check if a key matches our own publicKey */
  function isMyKey(key: string): boolean {
    if (!myPublicKey) return false

    return stripKeyPrefix(key) === stripKeyPrefix(myPublicKey)
  }

  // Contact suggestions — sourced from the main contact list (nook-contacts-v2),
  // so adding someone in the Contacts page makes them available here without
  // re-typing keys. Excludes self and already-granted contacts.
  const contactSuggestions: [string, string][] = contacts
    .filter(c => {
      if (isMyKey(c.beePublicKey)) return false

      if (grantees.some(g => stripKeyPrefix(g) === stripKeyPrefix(c.beePublicKey))) return false

      const q = query.trim().toLowerCase()

      if (q) return c.nickname.toLowerCase().includes(q) || c.id.toLowerCase().includes(q)

      return true
    })
    .map<[string, string]>(c => [c.beePublicKey, c.nickname])
    .slice(0, 6)

  // Load existing grantees on first render
  if (!loadedGrantees && granteeRef) {
    setLoadedGrantees(true)
    serverApi
      .getGrantees(granteeRef)
      .then(result => {
        // MERGE with local state instead of overwriting: a grant made while
        // this request was in flight would otherwise vanish from the list and
        // re-granting it would look like a fresh key (finding #8 race —
        // "first Martin was not visible, then 2").
        setGrantees(prev => {
          const merged = [...result.grantees]

          for (const k of prev) {
            if (!merged.some(m => stripKeyPrefix(m) === stripKeyPrefix(k))) merged.push(k)
          }

          return merged
        })
        // Server list is the truth — heal the drive card's cached count.
        // Count OTHER people explicitly: depending on how a drive was created
        // its list may or may not contain the owner's own key, so raw list
        // length is off-by-one for some drives. Stored convention: others + 1.
        onGranteeCount?.(result.grantees.filter(g => !isMyKey(g)).length + 1)
      })
      .catch(() => undefined)
  }

  /**
   * Re-resolve a cached contact's identity and, if their sharing key changed
   * (reinstall regenerates the bee node key), persist the fresh keys and
   * return the updated contact. Returns null when the key is current or the
   * lookup fails — the caller keeps the cached key.
   */
  async function refreshStaleContactKey(cached: NookContact, cachedKey: string): Promise<NookContact | null> {
    try {
      const fresh = await identity.resolve(bee, cached.id)

      if (!fresh || stripKeyPrefix(fresh.beePublicKey) === stripKeyPrefix(cachedKey)) return null
      updateContactKeys(contacts, cached.id, {
        walletPublicKey: fresh.walletPublicKey,
        beePublicKey: fresh.beePublicKey,
      })
      setContacts(loadContacts())
      setKeyRefreshNote(
        `${cached.nickname}'s sharing key changed (they probably reinstalled) — shared to their current key. ` +
          'Nothing else needed — they’ve been notified.',
      )

      return { ...cached, walletPublicKey: fresh.walletPublicKey, beePublicKey: fresh.beePublicKey }
    } catch {
      return null
    }
  }

  async function handleGrant() {
    const input = newKey.trim()
    let key = input
    // The recipient we can notify (needs a wallet public key for ECDH). Captured
    // across all three input paths so we can notify inline when the box is checked.
    let grantedContact: NookContact | null = null

    setLoading(true)
    setError(null)

    try {
      // Three accepted input formats:
      //   1. Contact link (nook://contact/v1?…) — has everything; decode & save contact
      //   2. Nook address (0x… 40 hex) — resolve via identity feed to bpub
      //   3. Raw sharing key (66/130 hex) — fallback for legacy / out-of-band keys
      if (input.startsWith('nook://contact')) {
        const decoded = decodeShareLink(input)

        if (!decoded.ok) {
          setError(decoded.error)

          return
        }
        const payload = decoded.payload
        key = payload.beePublicKey
        const alreadyContact = contacts.some(c => c.id.toLowerCase() === payload.ethAddress.toLowerCase())
        const isSelf = signer?.getAddress().toLowerCase() === payload.ethAddress.toLowerCase()

        if (!isSelf) {
          grantedContact = {
            id: payload.ethAddress.toLowerCase(),
            nickname: newLabel.trim() || payload.nickname || payload.ethAddress.slice(0, 8),
            walletPublicKey: payload.walletPublicKey,
            beePublicKey: payload.beePublicKey,
            source: 'share-link',
            addedAt: Date.now(),
          }
        }

        if (!alreadyContact && !isSelf) {
          try {
            addContact(contacts, {
              id: payload.ethAddress.toLowerCase(),
              nickname: newLabel.trim() || payload.nickname || payload.ethAddress.slice(0, 8),
              walletPublicKey: payload.walletPublicKey,
              beePublicKey: payload.beePublicKey,
              source: 'share-link',
              addedAt: Date.now(),
            })
          } catch {
            // Race: contact added in another tab — non-fatal
          }
        }
      } else if (isEthAddress(input)) {
        const resolved = await identity.resolve(bee, input)

        if (!resolved) {
          setError(
            `Could not find identity for ${input}. They must publish first, or paste their contact link instead.`,
          )

          return
        }
        key = resolved.beePublicKey
        // If we resolved an address and have a label, save the contact so
        // the user doesn't repeat this lookup next time.
        const alreadyContact = contacts.some(c => c.id.toLowerCase() === input.toLowerCase())
        const isSelf = signer?.getAddress().toLowerCase() === input.toLowerCase()
        const existing = contacts.find(c => c.id.toLowerCase() === input.toLowerCase())

        if (!isSelf) {
          grantedContact = {
            id: input.toLowerCase(),
            nickname: newLabel.trim() || existing?.nickname || input.slice(0, 8),
            walletPublicKey: resolved.walletPublicKey,
            beePublicKey: resolved.beePublicKey,
            source: 'identity-feed',
            addedAt: Date.now(),
          }
        }

        if (!alreadyContact && !isSelf && newLabel.trim()) {
          try {
            // Persists to localStorage; in-memory `contacts` here stays stale
            // until next render, which is fine — only matters for repeat
            // grants in the same modal session.
            addContact(contacts, {
              id: input.toLowerCase(),
              nickname: newLabel.trim(),
              walletPublicKey: resolved.walletPublicKey,
              beePublicKey: resolved.beePublicKey,
              source: 'identity-feed',
              addedAt: Date.now(),
            })
          } catch {
            // Race: contact added in another tab — non-fatal
          }
        }
      } else if (!isValidPublicKey(input)) {
        setError('Paste a Nook address, a contact link (nook://contact…), or a hex sharing key.')

        return
      } else {
        // Raw sharing key — usually a click on a contact suggestion. Cached
        // keys go stale when the contact reinstalls (wallet-derived id
        // survives, bee node key is regenerated), and a grant to a dead key
        // fails silently for the recipient. Re-resolve their identity and
        // prefer the network's current key; best-effort — the cached key
        // still grants if the lookup fails.
        const cached = contactsForNodeKey(contacts, key)[0]
        const refreshed = cached && isEthAddress(cached.id) ? await refreshStaleContactKey(cached, key) : null

        if (refreshed) {
          key = refreshed.beePublicKey
          grantedContact = refreshed
        }
      }

      // Already has access — don't re-grant (avoids a redundant ACT op and a
      // duplicate row in the list). Just (re)notify with the current history.
      if (grantees.some(g => stripKeyPrefix(g) === stripKeyPrefix(key))) {
        setNewKey('')
        setNewLabel('')
        setQuery('')
        const existingTarget = grantedContact ?? contactForGrantee(key) ?? null

        if (existingTarget?.walletPublicKey) {
          try {
            const fail = await notifyContacts([existingTarget])

            if (fail) setError(`Already has access — but the notification failed: ${fail}`)
          } catch (e) {
            setError(`Already has access — but the notification failed: ${(e as Error).message}`)
          }
        }

        return
      }

      let result

      if (granteeRef && actHistoryRef) {
        result = await serverApi.patchGrantees(granteeRef, stampId, actHistoryRef, [key])
      } else {
        // Pass existing ACT history from file uploads so grantees are added to the SAME chain
        result = await serverApi.createGrantees(stampId, [key], actHistoryRef || undefined)
      }

      setGrantees(prev => [...prev, key])

      // If user typed a manual label for someone NOT in their contact list
      // (and we didn't already save them via address resolve), remember it
      // so the grantee row shows a name.
      const matchedContact = contactsForNodeKey(contacts, key)[0]

      if (newLabel.trim() && !matchedContact) saveLabel(key, newLabel.trim())

      setNewKey('')
      setNewLabel('')
      setQuery('')
      setLastRemoved(null)
      onUpdate({
        granteeRef: result.ref,
        historyRef: result.historyRef,
        granteeCount: [...grantees, key].filter(g => !isMyKey(g)).length + 1,
      })

      // Refresh from localStorage so a newly-added contact is matched for the
      // grantee list + the post-grant "Send notification" button.
      setContacts(loadContacts())

      // One-step share: notify the recipient in Messages right after granting.
      // A notify failure must NOT read as a grant failure — the grant succeeded.
      const notifyTarget = grantedContact ?? contactForGrantee(key) ?? null

      if (notifyTarget?.walletPublicKey) {
        if (!files?.length) {
          // Grant succeeded, but an empty drive has nothing to put in the link yet.
          setError('Access granted. Add a file to this drive, then notify them with the bell next to their name.')
        } else {
          try {
            // Pass the grant's fresh historyRef so the shared metadata is encrypted
            // against the chain that includes this grantee (the prop is still stale).
            const fail = await notifyContacts([notifyTarget], result.historyRef)

            if (fail) setError(`Access granted, but notification failed: ${fail}`)
          } catch (e) {
            setError(`Access granted, but notification failed: ${(e as Error).message}`)
          }
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to grant access')
    } finally {
      setLoading(false)
    }
  }

  async function handleRevoke(key: string) {
    if (!granteeRef || !actHistoryRef) return
    setLoading(true)
    setError(null)

    try {
      const result = await serverApi.patchGrantees(granteeRef, stampId, actHistoryRef, undefined, [key])
      setGrantees(prev => prev.filter(g => g !== key))
      // Revoke rotates the ACT key in Bee, so existing files are now locked under
      // the old key. Flag the drive so the UI prompts a re-publish — re-granting
      // anyone later can't restore access to existing files without re-uploading.
      onUpdate({
        granteeRef: result.ref,
        historyRef: result.historyRef,
        granteeCount: grantees.filter(g => g !== key && !isMyKey(g)).length + 1,
        keyRotated: true,
      })

      // Tell them (R4-15, visible note — user decision). Best effort: the
      // removal itself already happened; their Nook also detects it on sync.
      const removed = contactForGrantee(key)

      setLastRemoved({
        name: removed?.nickname ?? findLabel(key) ?? 'They',
        told: Boolean(removed?.walletPublicKey && signer),
      })

      if (removed) {
        markRemovedFromDrive(stampId, removed.id)
        void sendAccessRemovedNote(removed)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to revoke access')
    } finally {
      setLoading(false)
    }
  }

  /**
   * Re-upload metadata with the latest ACT history (so newly-granted users can
   * read it) and update the feed pointer. Returns the share link.
   *
   * Both Copy link and Send notification need to do this — extracted so the
   * recipient never gets a stale link pointing at metadata they can't decrypt.
   */
  async function refreshAndBuildLink(historyOverride?: string): Promise<string> {
    // After a grant, the new ACT history ref isn't on the `actHistoryRef` prop
    // yet (the parent's onUpdate state hasn't flowed back this tick). Callers in
    // the grant→notify path pass the grant's fresh historyRef so the metadata is
    // encrypted against the chain that INCLUDES the new grantee — otherwise the
    // recipient reads metadata from the pre-grant history and gets a 403.
    const history = historyOverride ?? actHistoryRef

    if (!actPublisher || !history || !beeAddress || !files?.length) {
      throw new Error('Drive is not ready to share yet')
    }

    if (!signer || !myPublicKey) {
      throw new Error('Sign in with Swarm ID first so the link can carry your contact info.')
    }
    const topic = await topicFromString(stampId + 'nook-drive-meta')
    const metadata = JSON.stringify({
      files: files.map(f => ({ name: f.name, reference: f.reference, historyRef: f.historyRef, size: f.size })),
    })
    const uploaded = await serverApi.uploadACTMetadata(stampId, metadata, history)
    const wrapper = JSON.stringify({ ref: uploaded.reference, history: uploaded.historyRef })
    const wrapperResult = await serverApi.uploadRawBytes(stampId, wrapper)

    await serverApi.createFeedUpdate(topic, wrapperResult.reference, stampId)

    // #93: never hand out a link to content the network can't serve. The
    // wrapper is what the recipient's feed read resolves first — verify it's
    // actually retrievable (uploads are direct, so this should pass fast).
    if (!(await waitForRetrievable(wrapperResult.reference, { attempts: 3, delayMs: 4000 }))) {
      throw new Error("Content hasn't reached the network yet — wait a moment and try sharing again.")
    }
    onWrapperRef?.(wrapperResult.reference)

    return buildShareLink({
      feedTopic: topic,
      feedOwner: beeAddress,
      actPublisher,
      sender: {
        addr: signer.getAddress(),
        walletPublicKey: bytesToHex(signer.getPublicKey()),
        name: myName || undefined,
      },
    })
  }

  /**
   * The drive's share link WITHOUT re-publishing the metadata — enough for the
   * recipient to recognise which of their shared drives a note is about
   * (feed topic + owner). Used for the access-removed note (nothing to read).
   */
  async function driveLinkOnly(): Promise<string | null> {
    if (!actPublisher || !beeAddress || !signer) return null

    return buildShareLink({
      feedTopic: await topicFromString(stampId + 'nook-drive-meta'),
      feedOwner: beeAddress,
      actPublisher,
      sender: {
        addr: signer.getAddress(),
        walletPublicKey: bytesToHex(signer.getPublicKey()),
        name: myName || undefined,
      },
    })
  }

  async function sendAccessRemovedNote(contact: NookContact) {
    if (!signer || !contact.walletPublicKey) return
    const link = await driveLinkOnly().catch(() => null)

    if (!link) return
    const who = myName || 'The owner'

    queueAndDeliver(bee, signer, stampId, contact, {
      kind: 'drive-access-removed',
      subject: `${who} removed your access to "${driveName}"`,
      body: `${who} removed your access to "${driveName}". Files you already downloaded stay with you.`,
      driveShare: { driveShareLink: link, driveName, fileCount: files?.length ?? 0 },
    })
  }

  /** Nook's first-contact ping only makes sense before you're connected. */
  function isConnected(contact: NookContact): boolean {
    const thread = loadThreads()[contact.id.toLowerCase()] ?? []

    return deriveConnectionState(contact.id, hasInboundSince(thread, contact.addedAt)) === 'connected'
  }

  async function copyShareLink() {
    setLoading(true)
    setError(null)
    try {
      const link = await refreshAndBuildLink()

      navigator.clipboard.writeText(link)
      setCopiedLink(true)
      setTimeout(() => setCopiedLink(false), 2000)
    } catch (e) {
      setError((e as Error).message || 'Failed to generate share link')
    } finally {
      setLoading(false)
    }
  }

  /**
   * The contact to notify for this grantee key (#122): when a person
   * re-derives their Nook identity on the same node, several contacts share
   * one node key — the NEWEST one is their current identity. First-found
   * used to route share notifications to the stale identity's mailbox,
   * which nobody reads.
   */
  function contactForGrantee(granteeKey: string) {
    return contactsForNodeKey(contacts, granteeKey)[0]
  }

  /** True when this grantee key maps to more than one contact (rotated identity). */
  function granteeIsAmbiguous(granteeKey: string): boolean {
    return contactsForNodeKey(contacts, granteeKey).length > 1
  }

  /** Every notifiable grantee (in contacts, has ECDH key, not me), deduped. */
  function collectNotifyTargets(): NookContact[] {
    const seen = new Set<string>()
    const targets: NookContact[] = []

    for (const key of grantees) {
      if (isMyKey(key)) continue
      const contact = contactForGrantee(key)

      if (!contact?.walletPublicKey || seen.has(contact.id)) continue
      seen.add(contact.id)
      targets.push(contact)
    }

    return targets
  }

  const anySending = Object.values(notifyStatus).includes('sending')

  async function notifyEveryone() {
    const targets = collectNotifyTargets()

    if (targets.length === 0 || anySending) return
    setError(null)
    const fail = await notifyContacts(targets)

    if (fail) setError(fail)
  }

  // One-click flow from the drive's "Notify recipients" prompt (#135):
  // fire the bulk send as soon as the grantee list has loaded.
  const autoNotifyFired = useRef(false)

  useEffect(() => {
    if (!autoNotify || autoNotifyFired.current) return

    if (grantees.length === 0 || !signer) return
    autoNotifyFired.current = true
    void notifyEveryone()
    // eslint-disable-next-line
  }, [autoNotify, grantees, signer])

  /**
   * Send the drive-share to an explicit set of contacts (each must carry a
   * walletPublicKey for ECDH). Refreshes the feed once, then per-recipient
   * sends the mailbox message and, if doOnChain, fires the Gnosis wake-up.
   * Takes contacts explicitly so callers (grant-time + the bulk button) don't
   * depend on stale derived state. Returns the last error message, or null.
   */
  async function notifyContacts(targets: NookContact[], historyOverride?: string): Promise<string | null> {
    if (!signer || targets.length === 0) return null

    // The recipient resolves us via our published identity feed to add us back.
    // Without publishing, the share message arrives but they can't connect to us.
    if (!isIdentityPublished(signer.getAddress())) {
      return 'Publish your Nook identity first (Account → Identity → Publish) so they can add you back.'
    }
    const link = await refreshAndBuildLink(historyOverride)
    const myAddr = signer.getAddress()
    const fileCount = files?.length ?? 0
    // Subject leads with sender name so a recipient peeking at the feed (eg
    // from an on-chain invitation, before adding us as contact) sees who.

    // On-chain wake-up, signed + paid by the node wallet (no external wallet),
    // sent automatically — but only to people we're not connected with yet
    // (R4-5; a connected contact already reads our mailbox). OPTIONAL (#132):
    // the mailbox share needs no gas and completes regardless; an empty node
    // xDAI balance skips the ping with a note, never blocks the share.
    let provider = null
    let pingSkipReason: string | null = null

    if (targets.some(c => !isConnected(c))) {
      // Rough gas need for the registry call — skip cleanly instead of sending
      // a transaction the node wallet cannot pay.
      if (nodeWallet && BigInt(nodeWallet.nativeTokenBalance) < BigInt('200000000000000')) {
        pingSkipReason = 'Your node wallet has no xDAI for the on-chain heads-up.'
      } else {
        provider = createNodeNotifyProvider()
      }
    }

    if (pingSkipReason) {
      setPingSkippedNote(
        `Shared without the on-chain heads-up: ${pingSkipReason} Recipients still receive everything in Nook.`,
      )
    }

    let lastFailMsg: string | null = null

    for (const contact of targets) {
      setNotifyStatus(prev => ({ ...prev, [contact.id]: 'sending' }))
      // Persistent outbox (#117): the entry + thread bubble are stored before
      // any network work, so the notification survives closing the app — the
      // Layout drain keeps retrying queued entries. A failed first attempt is
      // therefore 'queued', not lost.
      // Re-sharing with someone we removed earlier = "Access restored" (R4-16).
      const restoring = wasRemovedFromDrive(stampId, contact.id)
      const who = myName || 'Someone'
      const { firstAttempt } = queueAndDeliver(bee, signer, stampId, contact, {
        kind: restoring ? 'drive-access-restored' : 'drive-share',
        subject: restoring ? `${who} restored your access to "${driveName}"` : `${who} shared "${driveName}" with you`,
        body: restoring
          ? `${who} restored your access to "${driveName}". Open it in Nook.`
          : `Drive shared. Open in Nook to add it.`,
        driveShare: { driveShareLink: link, driveName, fileCount },
      })

      if (restoring) clearRemovedFromDrive(stampId, contact.id)
      // A queued (not yet delivered) notification is NOT a failure — no error
      // surfaced; the row badge shows "queued" and the outbox delivers it.
      const delivered = await firstAttempt
      setNotifyStatus(prev => ({ ...prev, [contact.id]: delivered ? 'sent' : 'queued' }))

      // On-chain wake-up — fired AFTER mailbox so the message is already in
      // the feed by the time recipient discovers the event and resolves us.
      if (provider && !isConnected(contact)) {
        try {
          const recipientPubKey = hexToBytes(contact.walletPublicKey)
          // Include our display name so the recipient's invitation shows who's
          // reaching out (payload is ECIES-encrypted to them — not public).
          const txHash = await registry.sendNotification(provider, REGISTRY_ADDRESS, recipientPubKey, contact.id, {
            sender: myAddr,
            name: myName || undefined,
          } as Parameters<typeof registry.sendNotification>[4])

          // eslint-disable-next-line no-console
          console.log(`On-chain wake-up to ${contact.nickname}: tx ${txHash}`)
        } catch (e) {
          // eslint-disable-next-line no-console
          console.error(`On-chain notify ${contact.nickname} failed:`, e)

          lastFailMsg = `Drive shared, but the on-chain heads-up failed (${shortErrorMessage(e)}) — recipients still receive it in Nook.`
        }
      }
    }

    return lastFailMsg
  }

  const others = grantees.filter(k => !isMyKey(k))
  const notifiable = collectNotifyTargets()

  function shortAddr(a: string): string {
    return `${a.slice(0, 6)}…${a.slice(-4)}`
  }

  function statusPill(status: NotifyStatus | undefined) {
    const map: Record<string, { text: string; bg: string; fg: string; title?: string }> = {
      sending: { text: 'Sending…', bg: 'rgba(148,163,184,0.15)', fg: 'rgb(var(--fg-muted))' },
      sent: { text: 'Notified', bg: 'rgba(74,222,128,0.12)', fg: '#16a34a' },
      queued: {
        text: 'Queued',
        bg: 'rgba(245,158,11,0.12)',
        fg: '#d97706',
        title: "The node couldn't send yet — the message is stored and will be delivered automatically",
      },
      failed: { text: 'Not sent', bg: 'rgba(239,68,68,0.12)', fg: '#ef4444' },
    }
    const p = (status && map[status]) || { text: 'Has access', bg: 'rgba(74,222,128,0.12)', fg: '#16a34a' }

    return (
      <span
        className="text-[10.5px] px-2 py-0.5 rounded-full whitespace-nowrap"
        title={p.title}
        style={{ backgroundColor: p.bg, color: p.fg }}
      >
        {p.text}
      </span>
    )
  }

  return (
    <div
      className="fixed inset-0 flex items-center justify-center z-50"
      style={{ backgroundColor: 'rgba(0,0,0,0.6)' }}
      onClick={onClose}
    >
      <div
        className="rounded-xl border p-6 w-[460px] space-y-5 max-h-[calc(100vh-2rem)] max-w-[calc(100vw-2rem)] overflow-y-auto"
        style={{ backgroundColor: 'rgb(var(--bg-surface))' }}
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Lock size={14} style={{ color: 'rgb(var(--accent))' }} />
            <p className="text-sm font-semibold">Share "{driveName}"</p>
          </div>
          <Button onClick={onClose} variant="ghost" size="icon" className="h-8 w-8">
            <X size={16} />
          </Button>
        </div>

        {/* After a removal (mock A3): the key rotated — say what that means for
            THIS drive, and offer the fix. Shown only when it applies. */}
        {keyRotated && onRepublish && (
          <div
            className="rounded-lg border px-3 py-3 space-y-2 text-xs"
            style={{ backgroundColor: 'rgba(245,158,11,0.08)', borderColor: 'rgba(245,158,11,0.35)' }}
          >
            {lastRemoved && (
              <p style={{ color: 'rgb(var(--fg))' }}>
                <b>{lastRemoved.name} no longer has access.</b>
                {lastRemoved.told && <> They&apos;ve been told in Nook.</>}
              </p>
            )}
            <p style={{ color: 'rgb(var(--fg))' }}>
              Files already on this drive are locked for anyone you add back later, until you re-publish the drive.
            </p>
            {republishMsg && <p style={{ color: 'rgb(var(--fg-muted))' }}>{republishMsg}</p>}
            <Button onClick={onRepublish} disabled={republishing} size="sm">
              <RefreshCw className={republishing ? 'animate-spin' : ''} />
              {republishing ? 'Re-publishing…' : 'Re-publish drive'}
            </Button>
          </div>
        )}
        {!keyRotated && republishMsg && (
          <p className="text-xs" style={{ color: 'rgb(var(--fg-muted))' }}>
            {republishMsg}
          </p>
        )}

        {/* Share with — one field (R4-5) */}
        <div>
          <p className="text-xs uppercase tracking-widest mb-2" style={{ color: 'rgb(var(--fg-muted))' }}>
            Share with
          </p>
          <div className="relative">
            <div className="flex gap-2">
              <Input
                id="share-with"
                value={query}
                onChange={e => {
                  const v = e.target.value
                  // Typing a contact's exact name counts as picking them; anything
                  // else is taken as a Nook address / link / key.
                  const byName = contacts.find(c => c.nickname.toLowerCase() === v.trim().toLowerCase())

                  setQuery(v)
                  setNewKey(byName && !isMyKey(byName.beePublicKey) ? byName.beePublicKey : v.trim())
                  setNewLabel(byName ? byName.nickname : '')
                  setShowSuggestions(true)
                }}
                onFocus={() => setShowSuggestions(true)}
                onBlur={() => setTimeout(() => setShowSuggestions(false), 200)}
                onKeyDown={e => {
                  if (e.key === 'Enter' && newKey.trim() && !loading) void handleGrant()
                }}
                placeholder="Name, Nook address or contact link"
                className="flex-1 text-xs"
              />
              <Button onClick={handleGrant} disabled={loading || !newKey.trim()} size="sm">
                {loading ? <RefreshCw className="animate-spin" /> : null}
                Share
              </Button>
            </div>
            {showSuggestions && contactSuggestions.length > 0 && (
              <div
                className="absolute z-10 w-full mt-1 rounded-lg border max-h-44 overflow-auto shadow-lg"
                style={{ backgroundColor: 'rgb(var(--bg-surface))', borderColor: 'rgb(var(--border))' }}
              >
                {contactSuggestions.map(([key, label]) => {
                  const c = contactsForNodeKey(contacts, key)[0]

                  return (
                    <button
                      key={key}
                      className="w-full text-left px-3 py-2 text-xs hover:bg-white/[0.04] flex items-center gap-2"
                      onMouseDown={e => {
                        e.preventDefault()
                        setQuery(label)
                        setNewLabel(label)
                        setNewKey(key)
                        setShowSuggestions(false)
                      }}
                    >
                      <span className="font-medium" style={{ color: 'rgb(var(--fg))' }}>
                        {label}
                      </span>
                      <span className="ml-auto font-mono" style={{ color: 'rgb(var(--fg-muted))' }}>
                        {c ? shortAddr(c.id) : `${key.slice(0, 10)}…`}
                      </span>
                    </button>
                  )
                })}
              </div>
            )}
          </div>
          <p className="text-[11px] mt-2" style={{ color: 'rgb(var(--fg-muted))' }}>
            A contact, a Nook address or a contact link. They get the drive in Messages right away.
          </p>
        </div>

        {error && (
          <p className="text-xs" style={{ color: '#ef4444' }}>
            {error}
          </p>
        )}
        {/* The share succeeded; only the optional on-chain heads-up was
            skipped (#132) — amber info, never an error. */}
        {pingSkippedNote && !error && (
          <p className="text-xs" style={{ color: '#f59e0b' }}>
            {pingSkippedNote}
          </p>
        )}
        {keyRefreshNote && !error && (
          <p className="text-xs" style={{ color: '#f59e0b' }}>
            {keyRefreshNote}
          </p>
        )}

        {/* People with access */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <p className="text-xs uppercase tracking-widest" style={{ color: 'rgb(var(--fg-muted))' }}>
              <Users size={10} className="inline mr-1" />
              People with access{others.length > 0 ? ` · ${others.length}` : ''}
            </p>
            {notifiable.length > 1 && (
              <button
                onClick={async () => notifyEveryone()}
                disabled={anySending}
                className="text-[11px] underline disabled:opacity-50"
                style={{ color: 'rgb(var(--fg-muted))' }}
                title="Send the updated drive to everyone with access"
              >
                Send update to everyone
              </button>
            )}
          </div>
          <div
            className="rounded-lg border divide-y max-h-60 overflow-auto"
            style={{ borderColor: 'rgb(var(--border))' }}
          >
            {others.length === 0 ? (
              <p className="text-xs p-3 text-center" style={{ color: 'rgb(var(--fg-muted))' }}>
                Only you can open this drive.
              </p>
            ) : (
              others.map(key => {
                const label = findLabel(key)
                const contact = contactForGrantee(key)
                const oldKeyOwner = contact ? undefined : contactForOldNodeKey(contacts, key)
                const status = contact ? notifyStatus[contact.id] : undefined
                const name = label || `${key.slice(0, 6)}…${key.slice(-4)}`

                return (
                  <div key={key} className="flex items-center gap-2.5 px-3 py-2.5">
                    <span
                      className="w-7 h-7 rounded-full grid place-items-center text-[11px] font-semibold shrink-0"
                      style={{ backgroundColor: 'rgb(var(--accent))', color: 'rgb(var(--primary-foreground))' }}
                    >
                      {name.charAt(0).toUpperCase()}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-medium truncate" style={{ color: 'rgb(var(--fg))' }}>
                        {name}
                      </span>
                      <span
                        className="block text-[10.5px] font-mono truncate"
                        title={contact?.id ?? key}
                        style={{ color: 'rgb(var(--fg-muted))' }}
                      >
                        {contact ? shortAddr(contact.id) : `key …${stripKeyPrefix(key).slice(-6)}`}
                      </span>
                      {/* Kept diagnostics (#8/#122): old key after a reinstall,
                          several identities on one node, not a contact. */}
                      {oldKeyOwner && (
                        <span
                          className="block text-[10.5px]"
                          style={{ color: '#d97706' }}
                          title={`This grant targets ${oldKeyOwner.nickname}'s previous sharing key (from before a reinstall) — they can't open the drive with it. Remove this row; sharing again already uses their current key.`}
                        >
                          {oldKeyOwner.nickname}&apos;s old key
                        </span>
                      )}
                      {contact && granteeIsAmbiguous(key) && (
                        <span
                          className="block text-[10.5px]"
                          style={{ color: '#d97706' }}
                          title={`Several contacts share this node key (a re-derived identity?). Messages go to the newest: ${contact.nickname}. Delete stale duplicates in Contacts if that's wrong.`}
                        >
                          2+ identities → {contact.nickname}
                        </span>
                      )}
                      {!contact && !oldKeyOwner && (
                        <span className="block text-[10.5px]" style={{ color: 'rgb(var(--fg-muted))' }}>
                          Not in your contacts — add them to send updates
                        </span>
                      )}
                    </span>
                    {statusPill(status)}
                    <span className="flex items-center gap-2 shrink-0 text-[11px]">
                      {contact?.walletPublicKey && (
                        <button
                          onClick={async () => {
                            const fail = await notifyContacts([contact])

                            if (fail) setError(`Couldn't send the update to ${contact.nickname}: ${fail}`)
                          }}
                          disabled={status === 'sending'}
                          className="hover:underline disabled:opacity-50"
                          style={{ color: 'rgb(var(--fg-muted))' }}
                          title="Re-send the drive after you've added files"
                        >
                          Send update
                        </button>
                      )}
                      <button
                        onClick={async () => handleRevoke(key)}
                        disabled={loading}
                        className="hover:underline disabled:opacity-50"
                        style={{ color: '#ef4444' }}
                      >
                        Remove
                      </button>
                    </span>
                  </div>
                )
              })
            )}
          </div>
        </div>

        {/* Other ways to share — the drive link, collapsed (mock A2). */}
        {actPublisher && beeAddress && others.length > 0 && (
          <div className="border-t pt-3" style={{ borderColor: 'rgb(var(--border))' }}>
            <button
              onClick={() => setShowOtherWays(v => !v)}
              className="w-full flex items-center justify-between text-xs"
              style={{ color: 'rgb(var(--fg-muted))' }}
            >
              Other ways to share
              <span>{showOtherWays ? '▾' : '▸'}</span>
            </button>
            {showOtherWays && (
              <div className="space-y-2 pt-3">
                <p className="text-xs" style={{ color: 'rgb(var(--fg-muted))' }}>
                  Copy a drive link to send another way. It includes your contact info so they can add you back; they
                  still need access given above to open it.
                </p>
                <Button
                  onClick={copyShareLink}
                  disabled={loading}
                  variant={copiedLink ? 'secondary' : 'outline'}
                  className="w-full"
                >
                  {loading ? <RefreshCw className="animate-spin" /> : copiedLink ? <Check /> : <Copy />}
                  {loading ? 'Generating…' : copiedLink ? 'Link copied!' : 'Copy drive link'}
                </Button>
              </div>
            )}
          </div>
        )}

        <p className="text-[10px]" style={{ color: 'rgb(var(--fg-muted))' }}>
          Removing someone stops future access; files they already downloaded stay with them.
        </p>
      </div>
    </div>
  )
}
