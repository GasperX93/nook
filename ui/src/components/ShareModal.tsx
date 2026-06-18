/**
 * ShareModal — manage grantees for an encrypted drive.
 * Paste a Nook address or contact link to grant access (raw sharing
 * key still accepted as a fallback). Generates a drive share link.
 */
import { Bee } from '@ethersphere/bee-js'
import { identity, mailbox, registry } from '@swarm-notify/sdk'
import { Bell, Copy, Check, Lock, RefreshCw, Trash2, Users, X } from 'lucide-react'
import { useMemo, useState } from 'react'
import { getWalletClient, switchChain } from '@wagmi/core'
import { useWalletClient } from 'wagmi'

import { topicFromString } from '../api/bee'
import { serverApi } from '../api/server'
import { bytesToHex, hexToBytes } from '../lib/hex'
import { useDerivedKey } from '../hooks/useDerivedKey'
import { GNOSIS_CHAIN_ID, REGISTRY_ADDRESS } from '../notify/constants'
import { appendSentDriveShare, loadThreads } from '../notify/messages'
import { createNotifyProvider } from '../notify/provider'
import { decodeShareLink } from '../notify/share-link'
import { addContact, isIdentityPublished, loadContacts } from '../notify/storage'
import { type NookContact, toLibraryContact } from '../notify/types'
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
  onUpdate: (data: { granteeRef: string; historyRef: string; granteeCount: number }) => void
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
  type NotifyStatus = 'idle' | 'sending' | 'sent' | 'failed'
  const [notifyStatus, setNotifyStatus] = useState<Record<string, NotifyStatus>>({})
  const [notifying, setNotifying] = useState(false)
  // Optional on-chain wake-up — fires a Gnosis registry event so recipients
  // who haven't added you yet still get a "someone wants to reach you" signal.
  const [sendOnChain, setSendOnChain] = useState(false)
  // Notify the recipient in Messages as part of granting (one-step share).
  const [notifyOnGrant, setNotifyOnGrant] = useState(true)
  const [onChainStatus, setOnChainStatus] = useState<Record<string, NotifyStatus>>({})
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

  /** Strip compression prefix (02/03/04) and 0x from a public key for comparison */
  function stripKeyPrefix(k: string): string {
    const clean = k.toLowerCase().replace('0x', '')

    // Compressed keys start with 02 or 03 (66 chars), uncompressed with 04 (130 chars)
    // Bee returns uncompressed without 04 prefix (128 chars)
    if (clean.length === 66 && (clean.startsWith('02') || clean.startsWith('03'))) {
      return clean.slice(2) // Remove 02/03 → 64 char X coordinate
    }

    if (clean.length === 130 && clean.startsWith('04')) {
      return clean.slice(2, 66) // Remove 04, take X coordinate only
    }

    // Uncompressed without prefix (128 chars) — take first 64 (X coordinate)
    if (clean.length === 128) {
      return clean.slice(0, 64)
    }

    return clean
  }

  /** Find a label for a key — prefers contact list, falls back to legacy label map. */
  function findLabel(key: string): string | undefined {
    const keyX = stripKeyPrefix(key)

    for (const c of contacts) {
      if (stripKeyPrefix(c.beePublicKey) === keyX) return c.nickname
    }

    if (labels[key]) return labels[key]

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
      .then(result => setGrantees(result.grantees))
      .catch(() => setGrantees([]))
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
      const matchedContact = contacts.find(c => stripKeyPrefix(c.beePublicKey) === stripKeyPrefix(key))

      if (newLabel.trim() && !matchedContact) saveLabel(key, newLabel.trim())

      setNewKey('')
      setNewLabel('')
      onUpdate({
        granteeRef: result.ref,
        historyRef: result.historyRef,
        granteeCount: grantees.length + 1,
      })

      // Refresh from localStorage so a newly-added contact is matched for the
      // grantee list + the post-grant "Send notification" button.
      setContacts(loadContacts())

      // One-step share: notify the recipient in Messages right after granting.
      // A notify failure must NOT read as a grant failure — the grant succeeded.
      const notifyTarget = grantedContact ?? contactForGrantee(key) ?? null

      if (notifyOnGrant && notifyTarget?.walletPublicKey) {
        try {
          const fail = await notifyContacts([notifyTarget], sendOnChain)

          if (fail) setError(`Access granted, but notification failed: ${fail}`)
        } catch (e) {
          setError(`Access granted, but notification failed: ${(e as Error).message}`)
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
      onUpdate({
        granteeRef: result.ref,
        historyRef: result.historyRef,
        granteeCount: grantees.length - 1,
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
  async function refreshAndBuildLink(): Promise<string> {
    if (!actPublisher || !actHistoryRef || !beeAddress || !files?.length) {
      throw new Error('Drive is not ready to share yet')
    }

    if (!signer || !myPublicKey) {
      throw new Error('Derive your Nook key first (Contacts page) so the link can carry your contact info.')
    }
    const topic = await topicFromString(stampId + 'nook-drive-meta')
    const metadata = JSON.stringify({
      files: files.map(f => ({ name: f.name, reference: f.reference, historyRef: f.historyRef, size: f.size })),
    })
    const uploaded = await serverApi.uploadACTMetadata(stampId, metadata, actHistoryRef)
    const wrapper = JSON.stringify({ ref: uploaded.reference, history: uploaded.historyRef })
    const wrapperResult = await serverApi.uploadRawBytes(stampId, wrapper)

    await serverApi.createFeedUpdate(topic, wrapperResult.reference, stampId)

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

  /** Find the contact whose beePublicKey matches this grantee key, if any. */
  function contactForGrantee(granteeKey: string) {
    const keyX = stripKeyPrefix(granteeKey)

    return contacts.find(c => stripKeyPrefix(c.beePublicKey) === keyX)
  }

  /**
   * Grantees that can be notified — they're in the contact list (so we have
   * their wpub for ECDH) and not us. Excludes already-sent recipients in the
   * current session so re-clicks don't re-fire.
   */
  const notifiableGrantees = useMemo(
    () =>
      grantees
        .filter(key => !isMyKey(key))
        .map(key => ({ granteeKey: key, contact: contactForGrantee(key) }))
        .filter((g): g is { granteeKey: string; contact: NonNullable<ReturnType<typeof contactForGrantee>> } =>
          Boolean(g.contact),
        ),
    [grantees, contacts],
  )

  const pendingNotify = notifiableGrantees.filter(g => notifyStatus[g.contact.id] !== 'sent')

  /**
   * Send the drive-share to an explicit set of contacts (each must carry a
   * walletPublicKey for ECDH). Refreshes the feed once, then per-recipient
   * sends the mailbox message and, if doOnChain, fires the Gnosis wake-up.
   * Takes contacts explicitly so callers (grant-time + the bulk button) don't
   * depend on stale derived state. Returns the last error message, or null.
   */
  async function notifyContacts(targets: NookContact[], doOnChain: boolean): Promise<string | null> {
    if (!signer || targets.length === 0) return null

    // The recipient resolves us via our published identity feed to add us back.
    // Without publishing, the share message arrives but they can't connect to us.
    if (!isIdentityPublished(signer.getAddress())) {
      return 'Publish your Nook identity first (Account → Identity → Publish) so they can add you back.'
    }
    const link = await refreshAndBuildLink()
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
    let provider = null

    if (doOnChain && walletClient) {
      if (walletClient.chain?.id !== GNOSIS_CHAIN_ID) {
        await switchChain(wagmiConfig, { chainId: GNOSIS_CHAIN_ID })
      }
      const gnosisClient = await getWalletClient(wagmiConfig, { chainId: GNOSIS_CHAIN_ID })

      provider = createNotifyProvider(gnosisClient)
    }

    let lastFailMsg: string | null = null

    for (const contact of targets) {
      setNotifyStatus(prev => ({ ...prev, [contact.id]: 'sending' }))
      try {
        await mailbox.send(
          bee,
          signer.getSigningKey(),
          stampId,
          signer.getSigningKey(),
          myAddr,
          toLibraryContact(contact),
          { subject, body, type: 'drive-share', driveShareLink: link, driveName, fileCount },
        )
        // Save locally so the sender sees the message in their own thread
        appendSentDriveShare(loadThreads(), contact.id, { driveShareLink: link, driveName, fileCount })
        setNotifyStatus(prev => ({ ...prev, [contact.id]: 'sent' }))
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error(`Notify ${contact.nickname} failed:`, e)
        lastFailMsg = (e as Error).message ?? 'send failed'
        setNotifyStatus(prev => ({ ...prev, [contact.id]: 'failed' }))
      }

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
          lastFailMsg = (e as Error).message ?? 'on-chain send failed'
          setOnChainStatus(prev => ({ ...prev, [contact.id]: 'failed' }))
        }
      }
    }

    return lastFailMsg
  }

  async function handleNotifyAll() {
    if (!signer) {
      setError('No Nook identity — set it up on the Account → Identity tab.')

      return
    }

    if (!files?.length) {
      setError('Drive has no files to share yet.')

      return
    }

    if (pendingNotify.length === 0) return

    // On-chain wake-up needs the wallet on Gnosis, but we don't force Gnosis
    // globally (that fights top-up/ENS) — just require a wallet here.
    if (sendOnChain && !walletClient) {
      setError('Connect a wallet to send on-chain wake-up notifications.')

      return
    }
    setNotifying(true)
    setError(null)
    try {
      const fail = await notifyContacts(
        pendingNotify.map(p => p.contact),
        sendOnChain,
      )

      if (fail) setError(`Notification send failed: ${fail}`)
    } catch (e) {
      setError((e as Error).message || 'Failed to prepare drive link')
    } finally {
      setNotifying(false)
    }
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
          <div
            className="rounded-lg border divide-y max-h-40 overflow-auto"
            style={{ borderColor: 'rgb(var(--border))' }}
          >
            {grantees.length === 0 ? (
              <p className="text-xs p-3" style={{ color: 'rgb(var(--fg-muted))' }}>
                No one else has access yet.
              </p>
            ) : (
              grantees.map(key => {
                const isMe = isMyKey(key)
                const label = findLabel(key)
                const contact = contactForGrantee(key)
                const status = contact ? notifyStatus[contact.id] : undefined

                return (
                  <div key={key} className="flex items-center justify-between px-3 py-2">
                    <span className="text-xs truncate flex-1" style={{ color: 'rgb(var(--fg-muted))' }}>
                      {label && (
                        <span className="font-medium mr-2" style={{ color: 'rgb(var(--fg))' }}>
                          {label}
                        </span>
                      )}
                      <span className="font-mono">
                        {key.slice(0, 12)}…{key.slice(-8)}
                      </span>
                      {isMe && (
                        <span
                          className="ml-2 text-[10px] font-sans font-medium px-1.5 py-0.5 rounded"
                          style={{ backgroundColor: 'rgba(74,222,128,0.12)', color: '#4ade80' }}
                        >
                          you
                        </span>
                      )}
                      {!isMe && status === 'sent' && (
                        <span
                          className="ml-2 text-[10px] font-sans font-medium px-1.5 py-0.5 rounded"
                          style={{ backgroundColor: 'rgba(74,222,128,0.12)', color: '#4ade80' }}
                        >
                          notified
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
                      <Button
                        onClick={async () => handleRevoke(key)}
                        disabled={loading}
                        variant="ghost"
                        size="icon"
                        className="shrink-0 ml-2 h-7 w-7 hover:text-red-400"
                        title="Revoke access"
                      >
                        <Trash2 size={12} />
                      </Button>
                    )}
                  </div>
                )
              })
            )}
          </div>
        </div>

        {/* Add grantee */}
        <div>
          <p className="text-xs uppercase tracking-widest mb-2" style={{ color: 'rgb(var(--fg-muted))' }}>
            Add someone
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
                placeholder="Name or select from contacts"
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
                placeholder="Nook address or contact link"
                className="flex-1 font-mono text-xs"
              />
              <Button onClick={handleGrant} disabled={loading || !newKey.trim()} size="sm">
                {loading ? <RefreshCw className="animate-spin" /> : null}
                Grant
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
              <span>Notify them in Messages with the drive link when granting.</span>
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
                  Also send on-chain wake-up (~0.001 xDAI) — for recipients who haven&apos;t added you back yet.
                  Requires wallet on Gnosis Chain.
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

        {/* Share drive link + warning */}
        <div className="border-t pt-4 space-y-3" style={{ borderColor: 'rgb(var(--border))' }}>
          {actPublisher && beeAddress && grantees.length > 0 && (
            <div className="space-y-2">
              <p className="text-xs" style={{ color: 'rgb(var(--fg-muted))' }}>
                After granting access, send them the drive link. The link also bundles your contact info so they can add
                you in one click.
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
                variant={copiedLink ? 'secondary' : 'default'}
                className="w-full"
              >
                {loading ? <RefreshCw className="animate-spin" /> : copiedLink ? <Check /> : <Copy />}
                {loading ? 'Generating…' : copiedLink ? 'Link copied!' : 'Copy drive link'}
              </Button>

              {/* Notify in Messages — sends a typed drive-share message to each
                  contact-grantee. Skips grantees not in the contact list. */}
              {notifiableGrantees.length > 0 &&
                (() => {
                  const names = pendingNotify.map(p => p.contact.nickname)
                  let recipients: string

                  if (names.length === 0) recipients = ''
                  else if (names.length <= 2) recipients = names.join(', ')
                  else recipients = `${names.length} contacts`

                  return (
                    <>
                      <Button
                        onClick={handleNotifyAll}
                        disabled={notifying || pendingNotify.length === 0}
                        variant="outline"
                        className="w-full"
                        title={
                          pendingNotify.length === 0
                            ? 'All eligible grantees already notified in this session'
                            : `Send a Messages notification to ${recipients}`
                        }
                      >
                        {notifying ? <RefreshCw className="animate-spin" /> : <Bell />}
                        {notifying
                          ? 'Sending…'
                          : pendingNotify.length === 0
                            ? 'All notified'
                            : `Send notification to ${recipients}`}
                      </Button>

                      {/* On-chain wake-up toggle — useful when recipient hasn't
                          added you back yet, so mailbox poll wouldn't pick it up. */}
                      <label
                        className="flex items-start gap-2 text-[11px] cursor-pointer pt-1"
                        style={{ color: 'rgb(var(--fg-muted))' }}
                      >
                        <input
                          type="checkbox"
                          checked={sendOnChain}
                          onChange={e => setSendOnChain(e.target.checked)}
                          className="mt-0.5"
                        />
                        <span>
                          Also send on-chain wake-up (~0.001 xDAI) — for recipients who haven&apos;t added you back yet.
                          Requires wallet on Gnosis Chain.
                        </span>
                      </label>
                    </>
                  )
                })()}
            </div>
          )}

          <p className="text-[10px]" style={{ color: 'rgb(var(--fg-muted))' }}>
            Revoking access prevents future reads but doesn't remove previously downloaded content.
          </p>
        </div>
      </div>
    </div>
  )
}
