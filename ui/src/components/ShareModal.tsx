/**
 * ShareModal — manage grantees for an encrypted drive.
 * Paste a sharing key (Bee publicKey) to grant access.
 * Generate a share link for the grantee to add the drive.
 */
import { Copy, Check, Lock, RefreshCw, Trash2, Users, X } from 'lucide-react'
import { useState } from 'react'

import { serverApi } from '../api/server'

interface ShareModalProps {
  driveName: string
  stampId: string
  /** First file's hash (used as the drive reference in share link) */
  driveReference?: string
  actPublisher?: string
  actHistoryRef?: string
  granteeRef?: string
  /** Node's own publicKey — to show "you" label in grantee list */
  myPublicKey?: string
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
  driveReference,
  actPublisher,
  actHistoryRef,
  granteeRef,
  myPublicKey,
  onClose,
  onUpdate,
}: ShareModalProps) {
  const [newKey, setNewKey] = useState('')
  const [newLabel, setNewLabel] = useState('')
  const [grantees, setGrantees] = useState<string[]>([])
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
        result = await serverApi.createGrantees(stampId, [key])
      }

      setGrantees(prev => [...prev, key])

      if (newLabel.trim()) saveLabel(key, newLabel.trim())

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

  function copyShareLink() {
    if (!driveReference || !actPublisher || !actHistoryRef) return
    const link = `swarm://${driveReference}?publisher=${actPublisher}&history=${actHistoryRef}`
    navigator.clipboard.writeText(link)
    setCopiedLink(true)
    setTimeout(() => setCopiedLink(false), 2000)
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
                const cleanKey = key.toLowerCase().replace('0x', '')
                const cleanMyKey = myPublicKey?.toLowerCase().replace('0x', '') ?? ''
                const isMe = cleanMyKey.length > 0 && (cleanKey.includes(cleanMyKey) || cleanMyKey.includes(cleanKey))

                return (
                  <div key={key} className="flex items-center justify-between px-3 py-2">
                    <span className="text-xs truncate flex-1" style={{ color: 'rgb(var(--fg-muted))' }}>
                      {labels[key] && (
                        <span className="font-medium mr-2" style={{ color: 'rgb(var(--fg))' }}>
                          {labels[key]}
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
            <input
              type="text"
              value={newLabel}
              onChange={e => setNewLabel(e.target.value)}
              placeholder="Name (optional)"
              className="w-full rounded-lg border px-3 py-2 text-xs focus:outline-none"
              style={{ backgroundColor: 'rgb(var(--bg))', color: 'rgb(var(--fg))' }}
            />
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

        {/* Share link */}
        {driveReference && actPublisher && actHistoryRef && grantees.length > 0 && (
          <div className="border-t pt-4" style={{ borderColor: 'rgb(var(--border))' }}>
            <div className="flex items-center justify-between mb-2">
              <p className="text-xs uppercase tracking-widest" style={{ color: 'rgb(var(--fg-muted))' }}>
                Share link
              </p>
              <button
                onClick={copyShareLink}
                className="flex items-center gap-1 text-xs font-medium transition-colors"
                style={{ color: copiedLink ? '#4ade80' : 'rgb(var(--accent))' }}
              >
                {copiedLink ? <Check size={11} /> : <Copy size={11} />}
                {copiedLink ? 'Copied' : 'Copy'}
              </button>
            </div>
            <p className="text-xs" style={{ color: 'rgb(var(--fg-muted))' }}>
              Send this link to people you've granted access to.
            </p>
          </div>
        )}

        {/* Warning */}
        <p className="text-[10px]" style={{ color: 'rgb(var(--fg-muted))' }}>
          Revoking access prevents future reads but doesn't remove previously downloaded content.
        </p>
      </div>
    </div>
  )
}
