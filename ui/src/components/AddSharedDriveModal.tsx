/**
 * AddSharedDriveModal — paste a share link to add a drive shared by someone else.
 * Supports both feed-based (live) and snapshot (legacy) share links.
 */
import { Check, Copy, Download, RefreshCw, X } from 'lucide-react'
import { useState } from 'react'

import { beeApi } from '../api/bee'
import { serverApi } from '../api/server'
import { parseShareLink } from '../hooks/useSharedDrives'
import type { SharedFile } from '../hooks/useSharedDrives'

interface AddSharedDriveModalProps {
  myPublicKey?: string
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
}

export default function AddSharedDriveModal({ myPublicKey, onClose, onAdd }: AddSharedDriveModalProps) {
  const [link, setLink] = useState('')
  const [name, setName] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copiedKey, setCopiedKey] = useState(false)

  async function handleAdd() {
    const parsed = parseShareLink(link)

    if (!parsed) {
      setError('Invalid share link.')

      return
    }

    setLoading(true)
    setError(null)

    try {
      let driveName = name.trim() || 'Shared drive'
      let files: SharedFile[] | undefined
      let reference = ''
      let actHistoryRef = ''

      if (parsed.type === 'feed' && parsed.feedTopic && parsed.feedOwner) {
        // Feed-based: read feed → get wrapper → ACT download metadata
        const wrapperText = await serverApi.readFeed(parsed.feedTopic, parsed.feedOwner)
        const wrapper = JSON.parse(wrapperText) as { ref: string; history: string }

        const blob = await beeApi.downloadFileWithACT(wrapper.ref, parsed.actPublisher, wrapper.history)
        const metadataText = await blob.text()
        const metadata = JSON.parse(metadataText)

        if (metadata.files?.length) files = metadata.files

        driveName = name.trim() || metadata.name || 'Shared drive'
        reference = wrapper.ref
        actHistoryRef = wrapper.history
      } else if (parsed.type === 'snapshot' && parsed.reference && parsed.actHistoryRef) {
        // Legacy snapshot: direct ACT download
        const blob = await beeApi.downloadFileWithACT(parsed.reference, parsed.actPublisher, parsed.actHistoryRef)
        const text = await blob.text()

        try {
          const metadata = JSON.parse(text)

          if (metadata.name) driveName = name.trim() || metadata.name

          if (metadata.files?.length) files = metadata.files
        } catch {
          // Not JSON — single file
        }

        reference = parsed.reference
        actHistoryRef = parsed.actHistoryRef
      }

      onAdd({
        name: driveName,
        reference,
        actPublisher: parsed.actPublisher,
        actHistoryRef,
        files,
        feedTopic: parsed.type === 'feed' ? parsed.feedTopic : undefined,
        feedOwner: parsed.type === 'feed' ? parsed.feedOwner : undefined,
      })
      onClose()
    } catch {
      setError('Could not access this drive. Make sure the owner has granted you access using your sharing key.')
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
            placeholder="swarm://feed?topic=...&owner=...&publisher=..."
            className="w-full rounded-lg border px-3 py-2 text-xs font-mono focus:outline-none resize-none h-20"
            style={{ backgroundColor: 'rgb(var(--bg))', color: 'rgb(var(--fg))' }}
          />
        </div>

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
