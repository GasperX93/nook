/**
 * AddSharedDriveModal — paste a share link to add a drive shared by someone else.
 * Downloads ACT-encrypted metadata to verify access and get the file list.
 */
import { Check, Copy, Download, RefreshCw, X } from 'lucide-react'
import { useState } from 'react'

import { beeApi } from '../api/bee'
import { parseShareLink } from '../hooks/useSharedDrives'

interface SharedFile {
  name: string
  reference: string
  historyRef: string
  size: number
}

interface AddSharedDriveModalProps {
  /** Node's publicKey — shown in error state so user can share it with the drive owner */
  myPublicKey?: string
  onClose: () => void
  onAdd: (drive: {
    name: string
    reference: string
    actPublisher: string
    actHistoryRef: string
    files?: SharedFile[]
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
      setError('Invalid share link. Expected format: swarm://reference?publisher=...&history=...')

      return
    }

    setLoading(true)
    setError(null)

    try {
      // Download the ACT-encrypted metadata
      const blob = await beeApi.downloadFileWithACT(parsed.reference, parsed.actPublisher, parsed.actHistoryRef)
      const text = await blob.text()

      let driveName = name.trim() || 'Shared drive'
      let files: SharedFile[] | undefined

      try {
        const metadata = JSON.parse(text)

        if (metadata.name) driveName = name.trim() || metadata.name

        if (metadata.files?.length) files = metadata.files
      } catch {
        // Not JSON metadata — single file share (legacy format)
      }

      onAdd({
        name: driveName,
        reference: parsed.reference,
        actPublisher: parsed.actPublisher,
        actHistoryRef: parsed.actHistoryRef,
        files,
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
            placeholder="swarm://reference?publisher=...&history=..."
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
