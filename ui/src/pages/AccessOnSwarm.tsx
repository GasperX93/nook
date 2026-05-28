/**
 * Access on Swarm — retrieve any file from the network by its Swarm hash.
 *
 * Standalone power-user page for downloading content that isn't part of one
 * of your local drives. Useful for shared references, public content, etc.
 */
import { Bee } from '@ethersphere/bee-js'
import { Download, ExternalLink, RefreshCw } from 'lucide-react'
import { useState } from 'react'

import { getBeeUrl } from '../api/bee'

async function fetchResolved(hash: string): Promise<{ blob: Blob; suggestedName: string | null }> {
  // Match the Bee Dashboard / swarm-desktop pattern: use bee-js downloadFile, which
  // walks the manifest server-side and returns the actual file content plus metadata
  // (name, content type). Works for both single-file uploads and collections.
  // bee-js requires an absolute URL. In dev, getBeeUrl() returns "/bee-api"
  // (the Vite proxy); resolve it against the current origin so bee-js accepts it.
  const beeBase = getBeeUrl().startsWith('http') ? getBeeUrl() : `${window.location.origin}${getBeeUrl()}`
  const bee = new Bee(beeBase)
  const file = await bee.downloadFile(hash)

  const data = file.data.toUint8Array()
  const blob = new Blob([data], { type: file.contentType || 'application/octet-stream' })

  return { blob, suggestedName: file.name ?? null }
}

export default function AccessOnSwarm() {
  const [hash, setHash] = useState('')
  const [filename, setFilename] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const trimmedHash = hash.trim()
  const previewUrl = trimmedHash ? `${getBeeUrl()}/bzz/${trimmedHash}/` : ''

  async function retrieve() {
    if (!trimmedHash) return
    setLoading(true)
    setError(null)
    try {
      const { blob, suggestedName } = await fetchResolved(trimmedHash)
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = filename.trim() || suggestedName || `${trimmedHash.slice(0, 12)}.bin`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
      setHash('')
      setFilename('')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Download failed')
    } finally {
      setLoading(false)
    }
  }

  function openInBrowser() {
    if (!previewUrl) return
    window.open(previewUrl, '_blank', 'noopener,noreferrer')
  }

  return (
    <div className="p-6 max-w-2xl mx-auto">
      <h1 className="text-lg font-semibold mb-1">Access on Swarm</h1>
      <p className="text-sm mb-6" style={{ color: 'rgb(var(--fg-muted))' }}>
        Retrieve any file from the Swarm network using its hash — even if it isn't part of one of your drives.
      </p>

      <div className="rounded-xl border p-5 space-y-4" style={{ backgroundColor: 'rgb(var(--bg-surface))' }}>
        <div>
          <label className="text-xs uppercase tracking-widest block mb-1.5" style={{ color: 'rgb(var(--fg-muted))' }}>
            Swarm hash
          </label>
          <input
            type="text"
            value={hash}
            onChange={e => setHash(e.target.value)}
            onKeyDown={async e => e.key === 'Enter' && retrieve()}
            placeholder="64-char hex…"
            className="w-full rounded-lg border px-3 py-2 text-xs font-mono focus:outline-none"
            style={{ backgroundColor: 'rgb(var(--bg))', color: 'rgb(var(--fg))' }}
            autoFocus
          />
        </div>
        {previewUrl && (
          <>
            <div>
              <label className="text-xs uppercase tracking-widest block mb-1.5" style={{ color: 'rgb(var(--fg-muted))' }}>
                Save as (optional)
              </label>
              <input
                type="text"
                value={filename}
                onChange={e => setFilename(e.target.value)}
                placeholder="filename.ext"
                className="w-full rounded-lg border px-3 py-2 text-xs focus:outline-none"
                style={{ backgroundColor: 'rgb(var(--bg))', color: 'rgb(var(--fg))' }}
              />
            </div>

            <div className="rounded-lg px-3 py-2 text-[11px] font-mono break-all" style={{ backgroundColor: 'rgb(var(--bg))', color: 'rgb(var(--fg-muted))' }}>
              <span className="block uppercase tracking-widest mb-1" style={{ fontSize: '9px' }}>Preview URL</span>
              {previewUrl}
            </div>
          </>
        )}

        {error && (
          <p className="text-xs px-3 py-2 rounded" style={{ backgroundColor: 'rgba(239,68,68,0.1)', color: '#ef4444' }}>
            {error}
          </p>
        )}

        <div className="flex gap-2">
          <button
            onClick={openInBrowser}
            disabled={!trimmedHash}
            className="flex-1 py-2 rounded-lg text-sm font-medium border disabled:opacity-40 flex items-center justify-center gap-2"
            style={{ borderColor: 'rgb(var(--border))', color: 'rgb(var(--fg))' }}
          >
            <ExternalLink size={13} />
            Open in browser
          </button>
          <button
            onClick={retrieve}
            disabled={loading || !trimmedHash}
            className="flex-1 py-2 rounded-lg text-sm font-semibold disabled:opacity-40 flex items-center justify-center gap-2"
            style={{ backgroundColor: 'rgb(var(--accent))', color: 'rgb(var(--primary-foreground))' }}
          >
            {loading ? <RefreshCw size={13} className="animate-spin" /> : <Download size={13} />}
            {loading ? 'Downloading…' : 'Download'}
          </button>
        </div>
      </div>
    </div>
  )
}
