/**
 * ShareModal — manage grantees for an encrypted drive.
 * Paste a sharing key (Bee publicKey) to grant access.
 * Generate a share link for the grantee to add the drive.
 */
import { Copy, Check, Lock, RefreshCw, Trash2, Users, X } from 'lucide-react'
import { useMemo, useState } from 'react'

import { topicFromString } from '../api/bee'
import { serverApi } from '../api/server'
import { useDerivedKey } from '../hooks/useDerivedKey'
import { loadContacts } from '../notify/storage'
import { buildShareLink } from '../hooks/useSharedDrives'

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
}

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
  const contacts = useMemo(() => loadContacts(), [])

  const [newKey, setNewKey] = useState('')
  const [newLabel, setNewLabel] = useState('')
  const [showSuggestions, setShowSuggestions] = useState(false)
  const [grantees, setGrantees] = useState<string[]>([])
  const [senderName, setSenderName] = useState('')
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
    const key = newKey.trim()

    if (!isValidPublicKey(key)) {
      setError('Invalid sharing key. Must be a 66 or 130 character hex public key.')

      return
    }

    setLoading(true)
    setError(null)

    try {
      let result

      if (granteeRef && actHistoryRef) {
        result = await serverApi.patchGrantees(granteeRef, stampId, actHistoryRef, [key])
      } else {
        // Pass existing ACT history from file uploads so grantees are added to the SAME chain
        result = await serverApi.createGrantees(stampId, [key], actHistoryRef || undefined)
      }

      setGrantees(prev => [...prev, key])

      // If user typed a manual label for someone NOT in their contact list,
      // remember it (legacy behavior) so the grantee row shows a name.
      const matchedContact = contacts.find(c => stripKeyPrefix(c.beePublicKey) === stripKeyPrefix(key))

      if (newLabel.trim() && !matchedContact) saveLabel(key, newLabel.trim())

      setNewKey('')
      setNewLabel('')
      onUpdate({
        granteeRef: result.ref,
        historyRef: result.historyRef,
        granteeCount: grantees.length + 1,
      })
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

  async function copyShareLink() {
    if (!actPublisher || !actHistoryRef || !beeAddress || !files?.length) return

    if (!signer || !myPublicKey) {
      setError('Derive your Nook key first (Contacts page) so the link can carry your contact info.')

      return
    }
    setLoading(true)
    setError(null)

    try {
      const topic = await topicFromString(stampId + 'nook-drive-meta')

      // Re-upload metadata with LATEST history (includes all grantees) and update feed
      const metadata = JSON.stringify({
        files: files.map(f => ({ name: f.name, reference: f.reference, historyRef: f.historyRef, size: f.size })),
      })
      const uploaded = await serverApi.uploadACTMetadata(stampId, metadata, actHistoryRef)

      // Upload wrapper as raw bytes (not /bzz file) so feed reader can use /bytes to read it
      const wrapper = JSON.stringify({ ref: uploaded.reference, history: uploaded.historyRef })
      const wrapperResult = await serverApi.uploadRawBytes(stampId, wrapper)

      await serverApi.createFeedUpdate(topic, wrapperResult.reference, stampId)

      const link = buildShareLink({
        feedTopic: topic,
        feedOwner: beeAddress,
        actPublisher,
        sender: {
          addr: signer.getAddress(),
          walletPublicKey: bytesToHex(signer.getPublicKey()),
          beePublicKey: myPublicKey,
          name: senderName.trim() || undefined,
        },
      })

      navigator.clipboard.writeText(link)
      setCopiedLink(true)
      setTimeout(() => setCopiedLink(false), 2000)
    } catch {
      setError('Failed to generate share link')
    } finally {
      setLoading(false)
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
          <button onClick={onClose} style={{ color: 'rgb(var(--fg-muted))' }}>
            <X size={16} />
          </button>
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
                    </span>
                    {!isMe && (
                      <button
                        onClick={async () => handleRevoke(key)}
                        disabled={loading}
                        className="shrink-0 ml-2 transition-colors hover:text-red-400 disabled:opacity-40"
                        style={{ color: 'rgb(var(--fg-muted))' }}
                        title="Revoke access"
                      >
                        <Trash2 size={12} />
                      </button>
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
              <input
                type="text"
                value={newLabel}
                onChange={e => {
                  setNewLabel(e.target.value)
                  setShowSuggestions(true)
                }}
                onFocus={() => setShowSuggestions(true)}
                onBlur={() => setTimeout(() => setShowSuggestions(false), 200)}
                placeholder="Name or select from contacts"
                className="w-full rounded-lg border px-3 py-2 text-xs focus:outline-none"
                style={{ backgroundColor: 'rgb(var(--bg))', color: 'rgb(var(--fg))' }}
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
              <input
                type="text"
                value={newKey}
                onChange={e => setNewKey(e.target.value)}
                placeholder="Paste their sharing key"
                className="flex-1 rounded-lg border px-3 py-2 text-xs font-mono focus:outline-none"
                style={{ backgroundColor: 'rgb(var(--bg))', color: 'rgb(var(--fg))' }}
              />
              <button
                onClick={handleGrant}
                disabled={loading || !newKey.trim()}
                className="px-3 py-2 rounded-lg text-xs font-semibold disabled:opacity-40 flex items-center gap-1"
                style={{ backgroundColor: 'rgb(var(--accent))', color: '#fff' }}
              >
                {loading ? <RefreshCw size={11} className="animate-spin" /> : null}
                Grant
              </button>
            </div>
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
              <input
                type="text"
                value={senderName}
                onChange={e => setSenderName(e.target.value)}
                placeholder="Your name (optional, shown to recipient)"
                className="w-full rounded-lg border px-3 py-2 text-xs focus:outline-none"
                style={{ backgroundColor: 'rgb(var(--bg))', color: 'rgb(var(--fg))' }}
              />
              <button
                onClick={copyShareLink}
                disabled={loading}
                className="w-full py-2 rounded-lg text-xs font-semibold flex items-center justify-center gap-1.5 disabled:opacity-40 transition-colors"
                style={{
                  backgroundColor: copiedLink ? 'rgba(74,222,128,0.15)' : 'rgb(var(--accent))',
                  color: copiedLink ? '#4ade80' : '#fff',
                }}
              >
                {loading ? (
                  <RefreshCw size={11} className="animate-spin" />
                ) : copiedLink ? (
                  <Check size={11} />
                ) : (
                  <Copy size={11} />
                )}
                {loading ? 'Generating…' : copiedLink ? 'Link copied!' : 'Copy drive link'}
              </button>
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
