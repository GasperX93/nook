/**
 * ShareModal — manage grantees for an encrypted drive.
 * Paste a Nook address or contact link to grant access (raw sharing
 * key still accepted as a fallback). Generates a drive share link.
 */
import { Bee } from '@ethersphere/bee-js'
import { identity, registry } from '@swarm-notify/sdk'
import { Bell, Copy, Check, Lock, RefreshCw, Trash2, Users, X } from 'lucide-react'
import { useEffect, useRef, useMemo, useState } from 'react'
import { getBalance, getWalletClient, switchChain } from '@wagmi/core'
import { useWalletClient } from 'wagmi'

import { topicFromString, waitForRetrievable } from '../api/bee'
import { serverApi } from '../api/server'
import { bytesToHex, hexToBytes } from '../lib/hex'
import { contactsForNodeKey, stripKeyPrefix } from '../lib/node-key'
import { useDerivedKey } from '../hooks/useDerivedKey'
import { GNOSIS_CHAIN_ID, REGISTRY_ADDRESS } from '../notify/constants'
import { queueAndDeliver } from '../notify/deliver'
import { createNotifyProvider } from '../notify/provider'
import { decodeShareLink } from '../notify/share-link'
import { addContact, isIdentityPublished, loadContacts, updateContactKeys } from '../notify/storage'
import { type NookContact } from '../notify/types'
import { buildShareLink } from '../hooks/useSharedDrives'
import { wagmiConfig } from '../wagmi'
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
  const { signer } = useDerivedKey()
  const { data: walletClient } = useWalletClient()
  // State (not useMemo) so it refreshes after a grant adds a new contact —
  // otherwise the just-granted person isn't matched as notifiable.
  const [contacts, setContacts] = useState(() => loadContacts())
  const bee = useMemo(() => new Bee(BEE_URL), [])

  const [newKey, setNewKey] = useState('')
  const [newLabel, setNewLabel] = useState('')
  const [showSuggestions, setShowSuggestions] = useState(false)
  const [grantees, setGrantees] = useState<string[]>([])
  const [senderName, setSenderName] = useState('')
  // Per-grantee notification status keyed by lowercased contact id (Nook addr)
  type NotifyStatus = 'idle' | 'sending' | 'sent' | 'queued' | 'failed'
  const [notifyStatus, setNotifyStatus] = useState<Record<string, NotifyStatus>>({})
  // Optional on-chain wake-up — fires a Gnosis registry event so recipients
  // who haven't added you yet still get a "someone wants to reach you" signal.
  const [sendOnChain, setSendOnChain] = useState(false)
  // Notify the recipient in Messages as part of granting (one-step share).
  const [notifyOnGrant, setNotifyOnGrant] = useState(true)
  const [onChainStatus, setOnChainStatus] = useState<Record<string, NotifyStatus>>({})
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

      if (newLabel.trim()) return c.nickname.toLowerCase().includes(newLabel.toLowerCase())

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
        setGrantees(result.grantees)
        // Server list is the truth — heal the drive card's cached count.
        // Count OTHER people explicitly: depending on how a drive was created
        // its list may or may not contain the owner's own key, so raw list
        // length is off-by-one for some drives. Stored convention: others + 1.
        onGranteeCount?.(result.grantees.filter(g => !isMyKey(g)).length + 1)
      })
      .catch(() => setGrantees([]))
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
        `${cached.nickname}'s sharing key changed (they probably reinstalled) — shared to their current key.`,
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
        const existingTarget = grantedContact ?? contactForGrantee(key) ?? null

        if (notifyOnGrant && existingTarget?.walletPublicKey) {
          try {
            const fail = await notifyContacts([existingTarget], sendOnChain)

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

      if (notifyOnGrant && notifyTarget?.walletPublicKey) {
        if (!files?.length) {
          // Grant succeeded, but an empty drive has nothing to put in the link yet.
          setError('Access granted. Add a file to this drive, then notify them with the bell next to their name.')
        } else {
          try {
            // Pass the grant's fresh historyRef so the shared metadata is encrypted
            // against the chain that includes this grantee (the prop is still stale).
            const fail = await notifyContacts([notifyTarget], sendOnChain, result.historyRef)

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
      throw new Error('Derive your Nook key first (Contacts page) so the link can carry your contact info.')
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
        name: senderName.trim() || undefined,
      },
    })
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
    const fail = await notifyContacts(targets, sendOnChain)

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
  async function notifyContacts(
    targets: NookContact[],
    doOnChain: boolean,
    historyOverride?: string,
  ): Promise<string | null> {
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
    const subject = senderName.trim()
      ? `${senderName.trim()} shared "${driveName}" with you`
      : `"${driveName}" shared with you`
    const body = `Drive shared. Open in Nook to add it.`

    // For the on-chain wake-up, switch to Gnosis just-in-time and re-fetch the
    // wallet client (stale across a chain switch — same pattern as ENSModal).
    // The ping is OPTIONAL (#132): the mailbox share needs no gas and must
    // complete regardless — a cancelled chain switch, a missing wallet, or an
    // empty xDAI balance skips the ping with a note, never blocks the share.
    let provider = null
    let pingSkipReason: string | null = null

    if (doOnChain && walletClient) {
      try {
        if (walletClient.chain?.id !== GNOSIS_CHAIN_ID) {
          await switchChain(wagmiConfig, { chainId: GNOSIS_CHAIN_ID })
        }
        const gnosisClient = await getWalletClient(wagmiConfig, { chainId: GNOSIS_CHAIN_ID })
        const balance = await getBalance(wagmiConfig, {
          address: gnosisClient.account.address,
          chainId: GNOSIS_CHAIN_ID,
        })

        // Rough gas need for the registry call — skip cleanly instead of
        // letting the wallet prompt a transaction that cannot be paid.
        if (balance.value < BigInt('200000000000000')) {
          pingSkipReason = 'Your wallet has no xDAI for the on-chain heads-up.'
        } else {
          provider = createNotifyProvider(gnosisClient)
        }
      } catch {
        pingSkipReason = 'Wallet not ready for the on-chain heads-up (chain switch declined or unavailable).'
      }
    } else if (doOnChain && !walletClient) {
      pingSkipReason = 'Connect a wallet to also send on-chain heads-ups.'
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
      const { firstAttempt } = queueAndDeliver(bee, signer, stampId, contact, {
        kind: 'drive-share',
        body,
        subject,
        driveShare: { driveShareLink: link, driveName, fileCount },
      })
      // A queued (not yet delivered) notification is NOT a failure — no error
      // surfaced; the row badge shows "queued" and the outbox delivers it.
      const delivered = await firstAttempt
      setNotifyStatus(prev => ({ ...prev, [contact.id]: delivered ? 'sent' : 'queued' }))

      // On-chain wake-up — fired AFTER mailbox so the message is already in
      // the feed by the time recipient discovers the event and resolves us.
      if (provider) {
        setOnChainStatus(prev => ({ ...prev, [contact.id]: 'sending' }))
        try {
          const recipientPubKey = hexToBytes(contact.walletPublicKey)
          // Include our display name so the recipient's invitation shows who's
          // reaching out (payload is ECIES-encrypted to them — not public).
          const txHash = await registry.sendNotification(provider, REGISTRY_ADDRESS, recipientPubKey, contact.id, {
            sender: myAddr,
            name: senderName.trim() || undefined,
          } as Parameters<typeof registry.sendNotification>[4])

          // eslint-disable-next-line no-console
          console.log(`On-chain wake-up to ${contact.nickname}: tx ${txHash}`)
          setOnChainStatus(prev => ({ ...prev, [contact.id]: 'sent' }))
        } catch (e) {
          // eslint-disable-next-line no-console
          console.error(`On-chain notify ${contact.nickname} failed:`, e)
          lastFailMsg = `Drive shared, but the on-chain heads-up failed (${(e as Error).message ?? 'send failed'}) — recipients still receive it in Nook.`
          setOnChainStatus(prev => ({ ...prev, [contact.id]: 'failed' }))
        }
      }
    }

    return lastFailMsg
  }

  return (
    <div
      className="fixed inset-0 flex items-center justify-center z-50"
      style={{ backgroundColor: 'rgba(0,0,0,0.6)' }}
      onClick={onClose}
    >
      <div
        className="rounded-xl border p-6 w-[420px] space-y-5"
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

        {/* Grantee list */}
        <div>
          <p className="text-xs uppercase tracking-widest mb-2" style={{ color: 'rgb(var(--fg-muted))' }}>
            <Users size={10} className="inline mr-1" />
            People with access
          </p>
          {collectNotifyTargets().length > 0 && (
            <button
              onClick={async () => notifyEveryone()}
              disabled={anySending}
              className="mb-2 flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium border transition-colors hover:bg-white/5"
              style={{ borderColor: 'rgb(var(--border))', color: 'rgb(var(--fg))' }}
              title="Send the updated drive to everyone with access, in one step"
            >
              {anySending ? <RefreshCw size={11} className="animate-spin" /> : <Bell size={11} />}
              Notify everyone of updates
            </button>
          )}
          <div
            className="rounded-lg border divide-y max-h-40 overflow-auto"
            style={{ borderColor: 'rgb(var(--border))' }}
          >
            {grantees.length === 0 ? (
              <p className="text-xs p-3" style={{ color: 'rgb(var(--fg-muted))' }}>
                Only you can open this drive. Add someone below to share it.
              </p>
            ) : (
              grantees.map(key => {
                const isMe = isMyKey(key)
                const label = findLabel(key)
                const contact = contactForGrantee(key)
                const status = contact ? notifyStatus[contact.id] : undefined

                return (
                  <div key={key} className="flex items-center justify-between px-3 py-2">
                    <span className="text-sm truncate flex-1" style={{ color: 'rgb(var(--fg-muted))' }}>
                      <span className="font-medium mr-2" style={{ color: 'rgb(var(--fg))' }}>
                        {isMe ? 'You' : label || `${key.slice(0, 6)}…${key.slice(-4)}`}
                      </span>
                      {!isMe && status === 'sent' && (
                        <span
                          className="ml-2 text-[10px] font-sans font-medium px-1.5 py-0.5 rounded"
                          style={{ backgroundColor: 'rgba(74,222,128,0.12)', color: '#4ade80' }}
                        >
                          notified
                        </span>
                      )}
                      {!isMe && status === 'queued' && (
                        <span
                          className="ml-2 text-[10px] font-sans font-medium px-1.5 py-0.5 rounded"
                          title="The node couldn't send yet — the message is stored and will be delivered automatically"
                          style={{ backgroundColor: 'rgba(245,158,11,0.12)', color: '#f59e0b' }}
                        >
                          queued
                        </span>
                      )}
                      {!isMe && contact && granteeIsAmbiguous(key) && (
                        <span
                          className="ml-2 text-[10px] font-sans font-medium px-1.5 py-0.5 rounded"
                          title={`Several contacts share this node key (a re-derived identity?). Notifications go to the newest: ${contact.nickname}. Delete stale duplicates in Contacts if that's wrong.`}
                          style={{ backgroundColor: 'rgba(245,158,11,0.12)', color: '#f59e0b' }}
                        >
                          2+ identities → {contact.nickname}
                        </span>
                      )}
                      {!isMe && contact && onChainStatus[contact.id] === 'sent' && (
                        <span
                          className="ml-1 text-[10px] font-sans font-medium px-1.5 py-0.5 rounded"
                          style={{ backgroundColor: 'rgba(96,165,250,0.12)', color: '#60a5fa' }}
                        >
                          + on-chain
                        </span>
                      )}
                      {!isMe && contact && onChainStatus[contact.id] === 'failed' && (
                        <span
                          className="ml-1 text-[10px] font-sans font-medium px-1.5 py-0.5 rounded"
                          style={{ backgroundColor: 'rgba(239,68,68,0.12)', color: '#ef4444' }}
                        >
                          on-chain failed
                        </span>
                      )}
                      {!isMe && status === 'sending' && (
                        <span
                          className="ml-2 text-[10px] font-sans font-medium px-1.5 py-0.5 rounded"
                          style={{ color: 'rgb(var(--fg-muted))' }}
                        >
                          sending…
                        </span>
                      )}
                      {!isMe && status === 'failed' && (
                        <span
                          className="ml-2 text-[10px] font-sans font-medium px-1.5 py-0.5 rounded"
                          style={{ backgroundColor: 'rgba(239,68,68,0.12)', color: '#ef4444' }}
                        >
                          failed
                        </span>
                      )}
                      {!isMe && !contact && (
                        <span
                          className="ml-2 text-[10px] font-sans px-1.5 py-0.5 rounded"
                          style={{ color: 'rgb(var(--fg-muted))' }}
                          title="Add this person to Contacts to enable in-app notifications"
                        >
                          not in contacts
                        </span>
                      )}
                    </span>
                    {!isMe && (
                      <div className="flex items-center shrink-0 gap-1 ml-2">
                        {contact?.walletPublicKey && (
                          <Button
                            onClick={async () => {
                              const fail = await notifyContacts([contact], sendOnChain)

                              if (fail) setError(`Couldn't resend to ${contact.nickname}: ${fail}`)
                            }}
                            disabled={status === 'sending'}
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7"
                            title="Notify of an update — re-send the drive in Messages"
                          >
                            {status === 'sending' ? (
                              <RefreshCw className="animate-spin" size={12} />
                            ) : (
                              <Bell size={12} />
                            )}
                          </Button>
                        )}
                        <Button
                          onClick={async () => handleRevoke(key)}
                          disabled={loading}
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 hover:text-red-400"
                          title="Revoke access"
                        >
                          <Trash2 size={12} />
                        </Button>
                      </div>
                    )}
                  </div>
                )
              })
            )}
          </div>
        </div>

        {/* Re-publish prompt — a revoke rotated the key, so existing files must be
            re-encrypted before (re-)granted people can open them. */}
        {(keyRotated || republishMsg) && onRepublish && (
          <div
            className="rounded-lg border px-3 py-2.5 space-y-2"
            style={{ backgroundColor: 'rgba(96,165,250,0.08)', borderColor: 'rgb(var(--accent))' }}
          >
            <p className="text-xs" style={{ color: 'rgb(var(--fg))' }}>
              {republishMsg ??
                'A grantee was revoked, so this drive’s key changed. Re-publish so people you (re-)grant can open the existing files.'}
            </p>
            {keyRotated && (
              <Button onClick={onRepublish} disabled={republishing} size="sm" className="w-full">
                <RefreshCw className={republishing ? 'animate-spin' : ''} />
                {republishing ? 'Re-publishing…' : 'Re-publish drive'}
              </Button>
            )}
          </div>
        )}

        {/* Add grantee */}
        <div>
          <p className="text-xs uppercase tracking-widest mb-2" style={{ color: 'rgb(var(--fg-muted))' }}>
            Share with someone
          </p>
          <div className="space-y-2">
            <div className="relative">
              <Input
                value={newLabel}
                onChange={e => {
                  setNewLabel(e.target.value)
                  setShowSuggestions(true)
                }}
                onFocus={() => setShowSuggestions(true)}
                onBlur={() => setTimeout(() => setShowSuggestions(false), 200)}
                placeholder="Type a name, or pick a contact"
                className="text-xs"
              />
              {showSuggestions && contactSuggestions.length > 0 && (
                <div
                  className="absolute z-10 w-full mt-1 rounded-lg border max-h-36 overflow-auto"
                  style={{ backgroundColor: 'rgb(var(--bg-surface))', borderColor: 'rgb(var(--border))' }}
                >
                  {contactSuggestions.map(([key, label]) => (
                    <button
                      key={key}
                      className="w-full text-left px-3 py-2 text-xs hover:bg-white/[0.04] flex items-center gap-2"
                      onMouseDown={e => {
                        e.preventDefault()
                        setNewLabel(label)
                        setNewKey(key)
                        setShowSuggestions(false)
                      }}
                    >
                      <span className="font-medium" style={{ color: 'rgb(var(--fg))' }}>
                        {label}
                      </span>
                      <span className="font-mono truncate" style={{ color: 'rgb(var(--fg-muted))' }}>
                        {key.slice(0, 12)}…
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div className="flex gap-2">
              <Input
                value={newKey}
                onChange={e => setNewKey(e.target.value)}
                placeholder="…or paste a Nook address / invite link"
                className="flex-1 font-mono text-xs"
              />
              <Button onClick={handleGrant} disabled={loading || !newKey.trim()} size="sm">
                {loading ? <RefreshCw className="animate-spin" /> : null}
                Share
              </Button>
            </div>

            {/* One-step share: notify the recipient in Messages as part of granting. */}
            <label
              className="flex items-start gap-2 text-[11px] cursor-pointer pt-1"
              style={{ color: 'rgb(var(--fg-muted))' }}
            >
              <input
                type="checkbox"
                checked={notifyOnGrant}
                onChange={e => setNotifyOnGrant(e.target.checked)}
                className="mt-0.5"
              />
              <span>Send them the drive in Messages</span>
            </label>
            {notifyOnGrant && (
              <label
                className="flex items-start gap-2 text-[11px] cursor-pointer"
                style={{ color: 'rgb(var(--fg-muted))' }}
              >
                <input
                  type="checkbox"
                  checked={sendOnChain}
                  onChange={e => setSendOnChain(e.target.checked)}
                  className="mt-0.5"
                />
                <span>
                  Also send a quick on-chain heads-up (~$0.001) — so they&apos;re notified even if they haven&apos;t
                  added you yet.
                </span>
              </label>
            )}
          </div>
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

        {/* Share by link (secondary) + revoke note */}
        <div className="border-t pt-4 space-y-3" style={{ borderColor: 'rgb(var(--border))' }}>
          {actPublisher && beeAddress && grantees.some(key => !isMyKey(key)) && (
            <div className="space-y-2">
              <p className="text-xs" style={{ color: 'rgb(var(--fg-muted))' }}>
                Already shared above? You can also copy a link to send it another way — it includes your contact info so
                they can add you back. They still need access granted above to open it.
              </p>
              <Input
                value={senderName}
                onChange={e => setSenderName(e.target.value)}
                placeholder="Your name (optional, shown to recipient)"
                className="text-xs"
              />
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

          <p className="text-[10px]" style={{ color: 'rgb(var(--fg-muted))' }}>
            Revoking stops future access, but anything already downloaded can&apos;t be unsent.
          </p>
        </div>
      </div>
    </div>
  )
}
