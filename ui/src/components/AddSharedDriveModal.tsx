/**
 * AddSharedDriveModal — paste a `nook://drive-share` link to add a drive shared
 * by someone else. If the link bundles the sender's contact info, offer to add
 * them as a contact in the same step.
 */
import { Check, Copy, Download, RefreshCw, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

import { beeApi } from '../api/bee'
import { serverApi } from '../api/server'
import { decryptWriteKey } from '../crypto/drive'
import {
  parseShareLink,
  parseShareLinkTyped,
  useSharedDrivesV2,
  type SenderContactInfo,
  type SharedDriveV2,
  type SharedFile,
} from '../hooks/useSharedDrives'
import { useDerivedKey } from '../hooks/useDerivedKey'
import { addContact, loadContacts } from '../notify/storage'
import type { NookContact } from '../notify/types'

interface AddSharedDriveModalProps {
  myPublicKey?: string
  /** Pre-fill the share-link textarea (e.g. when opened from a Messages drive-share card) */
  initialLink?: string
  onClose: () => void
  onAdd: (drive: {
    name: string
    reference: string
    actPublisher: string
    actHistoryRef: string
    files?: SharedFile[]
    feedTopic?: string
    feedOwner?: string
  }) => void
  /** Called when a v2 shared drive is imported — separate from legacy onAdd */
  onAddV2?: (drive: SharedDriveV2) => void
}

export default function AddSharedDriveModal({
  myPublicKey,
  initialLink,
  onClose,
  onAdd,
  onAddV2,
}: AddSharedDriveModalProps) {
  const [link, setLink] = useState(initialLink ?? '')
  const [name, setName] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copiedKey, setCopiedKey] = useState(false)

  const { signer, derive } = useDerivedKey()
  const { addDrive: addDriveV2 } = useSharedDrivesV2()

  // Sender contact import
  const existingContacts = useMemo<NookContact[]>(() => loadContacts(), [])
  const [addAsContact, setAddAsContact] = useState(true)
  const [contactNickname, setContactNickname] = useState('')

  const parsedTyped = useMemo(() => (link.trim() ? parseShareLinkTyped(link) : null), [link])
  const parsed = useMemo(() => (link.trim() ? parseShareLink(link) : null), [link])
  const sender: SenderContactInfo | undefined =
    (parsedTyped?.type === 'nook-drive-share-v1'
      ? parsedTyped.sender
      : parsedTyped?.type === 'nook-drive-share-v2'
        ? parsedTyped.sender
        : undefined) ?? parsed?.sender
  const senderAlreadyContact = useMemo(() => {
    if (!sender) return false

    return existingContacts.some(c => c.id.toLowerCase() === sender.addr.toLowerCase())
  }, [sender, existingContacts])
  const showContactImport = Boolean(sender) && !senderAlreadyContact

  // Pre-fill nickname from sender's bundled name (or empty if absent)
  useEffect(() => {
    if (sender && !contactNickname) setContactNickname(sender.name ?? '')
  }, [sender, contactNickname])

  async function handleAdd() {
    if (!parsedTyped && !parsed) {
      setError('Invalid share link.')

      return
    }

    if (showContactImport && addAsContact && !contactNickname.trim()) {
      setError('Type a nickname for the new contact, or uncheck "Add as contact".')

      return
    }

    setLoading(true)
    setError(null)

    // ── V2 shared drive path ────────────────────────────────────────────────
    if (parsedTyped?.type === 'nook-drive-share-v2') {
      try {
        let writeKeyHex: string | undefined

        if (parsedTyped.writeKeyBlob && parsedTyped.role === 'writer') {
          let activeSigner = signer

          if (!activeSigner) activeSigner = await derive()

          if (!activeSigner) {
            setError('Connect your wallet to import a writer drive.')
            setLoading(false)

            return
          }
          try {
            const wkBytes = await decryptWriteKey(hexToBytes(parsedTyped.writeKeyBlob), activeSigner.getSigningKey())
            writeKeyHex = bytesToHex(wkBytes)
          } catch {
            // Decryption failed — add as reader-only
          }
        }

        const driveName = name.trim() || parsedTyped.name || 'Shared drive'
        const drive: SharedDriveV2 = {
          driveId: parsedTyped.driveId,
          name: driveName,
          creatorAddress: parsedTyped.creatorAddress,
          myRole: writeKeyHex ? 'writer' : 'reader',
          writeKey: writeKeyHex,
          writeKeyVersion: parsedTyped.writeKeyVersion,
          walletPublicKey: parsedTyped.walletPublicKey,
          driveFeedTopic: parsedTyped.driveFeedTopic,
          addedAt: Date.now(),
        }

        if (onAddV2) onAddV2(drive)
        else addDriveV2(drive)

        if (showContactImport && addAsContact && sender) {
          tryAddSenderContact(sender, contactNickname.trim(), existingContacts)
        }

        onClose()

        return
      } catch {
        setError('Could not add this drive. Check the link and try again.')
        setLoading(false)

        return
      }
    }

    // ── Legacy v1 path ──────────────────────────────────────────────────────
    if (!parsed) {
      setError('Invalid share link.')
      setLoading(false)

      return
    }

    try {
      // Drive: read feed → get wrapper → ACT download metadata
      const wrapperText = await serverApi.readFeed(parsed.feedTopic, parsed.feedOwner)
      const wrapper = JSON.parse(wrapperText) as { ref: string; history: string }

      const blob = await beeApi.downloadFileWithACT(wrapper.ref, parsed.actPublisher, wrapper.history)
      const metadataText = await blob.text()
      const metadata = JSON.parse(metadataText)

      const driveName = name.trim() || metadata.name || 'Shared drive'
      const files: SharedFile[] | undefined = metadata.files?.length ? metadata.files : undefined

      // Add the drive
      onAdd({
        name: driveName,
        reference: wrapper.ref,
        actPublisher: parsed.actPublisher,
        actHistoryRef: wrapper.history,
        files,
        feedTopic: parsed.feedTopic,
        feedOwner: parsed.feedOwner,
      })

      // Optionally add the sender as contact
      if (showContactImport && addAsContact && sender) {
        try {
          addContact(existingContacts, {
            id: sender.addr.toLowerCase(),
            nickname: contactNickname.trim(),
            walletPublicKey: sender.walletPublicKey,
            beePublicKey: sender.beePublicKey,
            source: 'drive-share',
            addedAt: Date.now(),
          })
        } catch {
          // Race with another tab adding the same contact — non-fatal
        }
      }

      onClose()
    } catch {
      setError('Could not access this drive. Make sure the owner has granted you access using your sharing key.')
    } finally {
      setLoading(false)
    }
  }

  function tryAddSenderContact(senderInfo: SenderContactInfo, nickname: string, contacts: NookContact[]) {
    try {
      addContact(contacts, {
        id: senderInfo.addr.toLowerCase(),
        nickname,
        walletPublicKey: senderInfo.walletPublicKey,
        beePublicKey: senderInfo.beePublicKey,
        source: 'drive-share',
        addedAt: Date.now(),
      })
    } catch {
      // Race with another tab — non-fatal
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
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Download size={14} style={{ color: 'rgb(var(--accent))' }} />
            <p className="text-sm font-semibold">Add shared drive</p>
          </div>
          <button onClick={onClose} style={{ color: 'rgb(var(--fg-muted))' }}>
            <X size={16} />
          </button>
        </div>

        <div>
          <p className="text-xs uppercase tracking-widest mb-2" style={{ color: 'rgb(var(--fg-muted))' }}>
            Drive name
          </p>
          <input
            type="text"
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="e.g. Alice's documents"
            className="w-full rounded-lg border px-3 py-2 text-sm focus:outline-none"
            style={{ backgroundColor: 'rgb(var(--bg))', color: 'rgb(var(--fg))' }}
            autoFocus
          />
        </div>

        <div>
          <p className="text-xs uppercase tracking-widest mb-2" style={{ color: 'rgb(var(--fg-muted))' }}>
            Share link
          </p>
          <textarea
            value={link}
            onChange={e => setLink(e.target.value)}
            placeholder="nook://drive-share?topic=...&owner=...&publisher=...&addr=...&wpub=...&bpub=..."
            className="w-full rounded-lg border px-3 py-2 text-xs font-mono focus:outline-none resize-none h-20"
            style={{ backgroundColor: 'rgb(var(--bg))', color: 'rgb(var(--fg))' }}
          />
        </div>

        {/* Sender contact import — only when link includes contact info AND not already a contact */}
        {showContactImport && sender && (
          <div
            className="rounded-lg border p-3 space-y-2"
            style={{ backgroundColor: 'rgb(var(--bg))', borderColor: 'rgb(var(--border))' }}
          >
            <label className="flex items-start gap-2 text-xs cursor-pointer">
              <input
                type="checkbox"
                checked={addAsContact}
                onChange={e => setAddAsContact(e.target.checked)}
                className="mt-0.5"
              />
              <span style={{ color: 'rgb(var(--fg))' }}>
                Also add sender as contact{' '}
                <span className="font-mono" style={{ color: 'rgb(var(--fg-muted))' }}>
                  ({sender.addr.slice(0, 8)}…{sender.addr.slice(-4)})
                </span>
              </span>
            </label>
            {addAsContact && (
              <input
                type="text"
                value={contactNickname}
                onChange={e => setContactNickname(e.target.value)}
                placeholder="Nickname for this contact"
                className="w-full rounded-lg border px-3 py-2 text-xs focus:outline-none"
                style={{ backgroundColor: 'rgb(var(--bg-surface))', color: 'rgb(var(--fg))' }}
              />
            )}
          </div>
        )}

        {sender && senderAlreadyContact && (
          <p className="text-xs" style={{ color: 'rgb(var(--fg-muted))' }}>
            Sender is already in your contacts.
          </p>
        )}

        {error && (
          <div className="space-y-2">
            <p className="text-xs" style={{ color: '#ef4444' }}>
              {error}
            </p>
            {myPublicKey && (
              <div
                className="rounded-lg border p-3 space-y-2"
                style={{ backgroundColor: 'rgb(var(--bg))', borderColor: 'rgb(var(--border))' }}
              >
                <p className="text-xs" style={{ color: 'rgb(var(--fg-muted))' }}>
                  Give your sharing key to the drive owner:
                </p>
                <div className="flex items-center gap-2">
                  <code className="text-xs font-mono truncate flex-1" style={{ color: 'rgb(var(--fg-muted))' }}>
                    {myPublicKey}
                  </code>
                  <button
                    onClick={() => {
                      navigator.clipboard.writeText(myPublicKey)
                      setCopiedKey(true)
                      setTimeout(() => setCopiedKey(false), 2000)
                    }}
                    className="shrink-0 flex items-center gap-1 text-xs font-medium"
                    style={{ color: copiedKey ? '#4ade80' : 'rgb(var(--accent))' }}
                  >
                    {copiedKey ? <Check size={10} /> : <Copy size={10} />}
                    {copiedKey ? 'Copied' : 'Copy'}
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        <div className="flex gap-3">
          <button
            onClick={onClose}
            className="flex-1 py-2 rounded-lg text-sm"
            style={{ color: 'rgb(var(--fg-muted))' }}
          >
            Cancel
          </button>
          <button
            onClick={handleAdd}
            disabled={loading || !link.trim()}
            className="flex-1 py-2 rounded-lg text-sm font-semibold disabled:opacity-40 flex items-center justify-center gap-2"
            style={{ backgroundColor: 'rgb(var(--accent))', color: '#fff' }}
          >
            {loading && <RefreshCw size={13} className="animate-spin" />}
            {loading ? 'Verifying…' : 'Add drive'}
          </button>
        </div>
      </div>
    </div>
  )
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex
  const out = new Uint8Array(clean.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16)

  return out
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
}
