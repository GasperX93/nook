/**
 * Access on Swarm — retrieve any file from the network by its Swarm hash.
 *
 * Standalone power-user page for downloading content that isn't part of one
 * of your local drives. Useful for shared references, public content, etc.
 */
import { Download, RefreshCw } from 'lucide-react'
import { useState } from 'react'

import { getBeeUrl } from '../api/bee'

async function fetchAny(hash: string): Promise<Blob> {
  // Try paths in order:
  //  1. /bzz/{hash}/ — manifests with index-document (websites, collections)
  //  2. /bzz/{hash}  — single-file wrapped manifests
  //  3. /bytes/{hash} — raw chunk
  const candidates = [`${getBeeUrl()}/bzz/${hash}/`, `${getBeeUrl()}/bzz/${hash}`, `${getBeeUrl()}/bytes/${hash}`]
  let lastError = ''

  for (const url of candidates) {
    try {
      const r = await fetch(url)
      if (r.ok) return r.blob()
      lastError = `${r.status} from ${url.replace(getBeeUrl(), '')}`
    } catch (e) {
      lastError = (e as Error).message
    }
  }
  throw new Error(`Could not retrieve from any path. Last error: ${lastError}`)
}

export default function AccessOnSwarm() {
  const [hash, setHash] = useState('')
  const [filename, setFilename] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function retrieve() {
    const h = hash.trim()

    if (!h) return
    setLoading(true)
    setError(null)
    try {
      const blob = await fetchAny(h)
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = filename.trim() || h.slice(0, 12)
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

        {error && (
          <p className="text-xs px-3 py-2 rounded" style={{ backgroundColor: 'rgba(239,68,68,0.1)', color: '#ef4444' }}>
            {error}
          </p>
        )}

        <button
          onClick={retrieve}
          disabled={loading || !hash.trim()}
          className="w-full py-2 rounded-lg text-sm font-semibold disabled:opacity-40 flex items-center justify-center gap-2"
          style={{ backgroundColor: 'rgb(var(--accent))', color: 'rgb(var(--primary-foreground))' }}
        >
          {loading ? <RefreshCw size={13} className="animate-spin" /> : <Download size={13} />}
          {loading ? 'Downloading…' : 'Download'}
        </button>
      </div>
    </div>
  )
}
