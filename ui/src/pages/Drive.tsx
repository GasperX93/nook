import { Check, Copy, Download, ExternalLink, File, FolderOpen, Globe, RefreshCw, Rss, Search, Trash2, Upload } from 'lucide-react'
import { useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { beeApi, calcStampCost, DURATION_PRESETS, getBeeUrl, topicFromString } from '../api/bee'
import { useAddresses, useChainState, useTopupStamp } from '../api/queries'
import { useUploadHistory, type UploadRecord } from '../hooks/useUploadHistory'
import { useAppStore } from '../store/app'
import {
  detectIndexDocument,
  fileListToEntries,
  readDroppedDirectory,
  totalSize,
  type FileEntry,
} from '../utils/directory'

function formatBytes(bytes: number): string {
  if (bytes >= 1_073_741_824) return `${(bytes / 1_073_741_824).toFixed(1)} GB`
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)} MB`
  return `${(bytes / 1024).toFixed(0)} KB`
}

function timeUntil(ms: number): { label: string; urgent: boolean } {
  const diff = ms - Date.now()
  if (diff <= 0) return { label: 'Expired', urgent: true }
  const days = Math.floor(diff / 86_400_000)
  if (days === 0) return { label: 'Today', urgent: true }
  if (days <= 7) return { label: `${days}d left`, urgent: true }
  if (days < 30) return { label: `${days}d left`, urgent: false }
  return { label: `${Math.floor(days / 30)}mo left`, urgent: false }
}

function ExpiryBar({ expiresAt, uploadedAt }: { expiresAt: number; uploadedAt: number }) {
  const total = expiresAt - uploadedAt
  const remaining = expiresAt - Date.now()
  const pct = Math.max(0, Math.min(100, (remaining / total) * 100))
  const urgent = remaining < 7 * 86_400_000

  return (
    <div className="h-1 rounded-full overflow-hidden w-24" style={{ backgroundColor: 'rgb(var(--border))' }}>
      <div
        className="h-full rounded-full transition-all"
        style={{
          width: `${pct}%`,
          backgroundColor: urgent ? '#ef4444' : pct < 30 ? '#facc15' : '#4ade80',
        }}
      />
    </div>
  )
}

// ─── Extend modal ─────────────────────────────────────────────────────────────

function ExtendModal({ stampId, onClose }: { stampId: string; onClose: () => void }) {
  const [durationIdx, setDurationIdx] = useState(1)
  const { data: chainState } = useChainState()
  const topup = useTopupStamp()

  const cost = chainState
    ? calcStampCost(20, DURATION_PRESETS[durationIdx].months, chainState.currentPrice)
    : null

  async function extend() {
    if (!cost) return
    await topup.mutateAsync({ id: stampId, amount: cost.amount })
    onClose()
  }

  return (
    <div
      className="fixed inset-0 flex items-center justify-center z-50"
      style={{ backgroundColor: 'rgba(0,0,0,0.6)' }}
      onClick={onClose}
    >
      <div
        className="rounded-xl border p-6 w-80 space-y-5"
        style={{ backgroundColor: 'rgb(var(--bg-surface))' }}
        onClick={e => e.stopPropagation()}
      >
        <div>
          <p className="text-sm font-semibold">Extend storage</p>
          <p className="text-xs mt-1" style={{ color: 'rgb(var(--fg-muted))' }}>
            Add more time to keep your file available.
          </p>
        </div>

        <div>
          <p className="text-xs uppercase tracking-widest mb-2" style={{ color: 'rgb(var(--fg-muted))' }}>
            Extend by
          </p>
          <div className="grid grid-cols-2 gap-2">
            {DURATION_PRESETS.map((d, i) => (
              <button
                key={d.label}
                onClick={() => setDurationIdx(i)}
                className="px-3 py-2 rounded-lg border text-sm transition-all"
                style={{
                  borderColor: durationIdx === i ? 'rgb(var(--accent))' : 'rgb(var(--border))',
                  backgroundColor: durationIdx === i ? 'rgba(247,104,8,0.08)' : 'transparent',
                  color: durationIdx === i ? 'rgb(var(--fg))' : 'rgb(var(--fg-muted))',
                }}
              >
                {d.label}
              </button>
            ))}
          </div>
        </div>

        {cost && (
          <p className="text-sm">
            <span style={{ color: 'rgb(var(--fg-muted))' }}>Cost: </span>
            <span className="font-semibold">{cost.bzzCost} BZZ</span>
          </p>
        )}

        <div className="flex gap-3">
          <button onClick={onClose} className="flex-1 py-2 rounded-lg text-sm" style={{ color: 'rgb(var(--fg-muted))' }}>
            Cancel
          </button>
          <button
            onClick={extend}
            disabled={topup.isPending || !cost}
            className="flex-1 py-2 rounded-lg text-sm font-semibold disabled:opacity-40"
            style={{ backgroundColor: 'rgb(var(--accent))', color: '#fff' }}
          >
            {topup.isPending ? 'Extending…' : 'Extend'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Update feed modal ────────────────────────────────────────────────────────

interface UpdateContent {
  entries: FileEntry[]
  size: number
  indexDocument: string
}

function UpdateFeedModal({ record, onClose }: { record: UploadRecord; onClose: () => void }) {
  const [content, setContent] = useState<UpdateContent | null>(null)
  const [dragging, setDragging] = useState(false)
  const [phase, setPhase] = useState<'select' | 'updating' | 'done'>('select')
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const fileInputRef = useRef<HTMLInputElement>(null)
  const dirInputRef = useRef<HTMLInputElement>(null)

  const { data: addresses } = useAddresses()
  const { update } = useUploadHistory()
  const { gatewayUrl } = useAppStore()

  async function handleDrop(e: React.DragEvent) {
    e.preventDefault()
    setDragging(false)
    if (record.type === 'file') {
      const file = e.dataTransfer.files[0]
      if (file) setContent({ entries: [{ path: file.name, file }], size: file.size, indexDocument: '' })
      return
    }
    const item = e.dataTransfer.items[0]
    if (!item) return
    try {
      const { entries } = await readDroppedDirectory(item)
      const index = detectIndexDocument(entries) ?? 'index.html'
      setContent({ entries, size: totalSize(entries), indexDocument: index })
    } catch {
      const file = e.dataTransfer.files[0]
      if (file) setContent({ entries: [{ path: file.name, file }], size: file.size, indexDocument: '' })
    }
  }

  function handleFileInput(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (file) setContent({ entries: [{ path: file.name, file }], size: file.size, indexDocument: '' })
  }

  function handleDirInput(e: React.ChangeEvent<HTMLInputElement>) {
    if (!e.target.files?.length) return
    const { entries } = fileListToEntries(e.target.files)
    const index = detectIndexDocument(entries) ?? 'index.html'
    setContent({ entries, size: totalSize(entries), indexDocument: index })
  }

  async function doUpdate() {
    if (!content || !addresses?.ethereum) return
    setPhase('updating')
    setError(null)
    try {
      // Upload new content using the existing stamp
      let reference: string
      if (record.type === 'file') {
        const res = await beeApi.uploadFile(content.entries[0].file, record.stampId)
        reference = res.reference
      } else {
        const opts = record.type === 'website'
          ? { indexDocument: content.indexDocument, errorDocument: '404.html' }
          : undefined
        const res = await beeApi.uploadCollection(content.entries, record.stampId, opts)
        reference = res.reference
      }

      // Push update to the feed
      const topicHex = await topicFromString(record.feedTopic ?? record.name)
      await beeApi.createFeedUpdate(addresses.ethereum, topicHex, reference, record.stampId)

      // Update the Drive record with the new content hash
      update(record.id, { hash: reference })
      setPhase('done')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Update failed')
      setPhase('select')
    }
  }

  return (
    <div
      className="fixed inset-0 flex items-center justify-center z-50"
      style={{ backgroundColor: 'rgba(0,0,0,0.6)' }}
      onClick={onClose}
    >
      <div
        className="rounded-xl border p-6 w-96 space-y-5"
        style={{ backgroundColor: 'rgb(var(--bg-surface))' }}
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div>
          <div className="flex items-center gap-2 mb-1">
            <Rss size={14} style={{ color: 'rgb(var(--accent))' }} />
            <p className="text-sm font-semibold">Update feed</p>
          </div>
          <p className="text-xs" style={{ color: 'rgb(var(--fg-muted))' }}>
            {record.name} · {record.feedTopic ?? record.name}
          </p>
        </div>

        {phase === 'select' && (
          <>
            {/* Drop zone */}
            <div
              onDragOver={e => { e.preventDefault(); setDragging(true) }}
              onDragLeave={() => setDragging(false)}
              onDrop={handleDrop}
              onClick={() => record.type === 'file' ? fileInputRef.current?.click() : dirInputRef.current?.click()}
              className="rounded-lg border-2 border-dashed cursor-pointer transition-colors"
              style={{
                borderColor: content ? 'rgb(var(--accent))' : dragging ? 'rgb(var(--accent))' : 'rgb(var(--border))',
                backgroundColor: dragging ? 'rgba(247,104,8,0.04)' : 'transparent',
              }}
            >
              <div className="py-8 flex flex-col items-center gap-2 text-center px-4">
                {content ? (
                  <>
                    <Check size={18} color="#4ade80" />
                    <p className="text-sm font-medium">{formatBytes(content.size)}</p>
                    <p className="text-xs" style={{ color: 'rgb(var(--fg-muted))' }}>
                      {content.entries.length > 1 ? `${content.entries.length} files` : content.entries[0]?.path}
                    </p>
                  </>
                ) : (
                  <>
                    <Upload size={18} style={{ color: 'rgb(var(--fg-muted))' }} />
                    <p className="text-sm" style={{ color: 'rgb(var(--fg-muted))' }}>
                      Drop new {record.type} here or click to browse
                    </p>
                  </>
                )}
              </div>
            </div>

            <input ref={fileInputRef} type="file" className="hidden" onChange={handleFileInput} />
            <input ref={dirInputRef} type="file" className="hidden"
              // @ts-expect-error — webkitdirectory not in TS types
              webkitdirectory="true"
              onChange={handleDirInput}
            />

            <p className="text-xs" style={{ color: 'rgb(var(--fg-muted))' }}>
              Uses existing storage. If the stamp is expired or full, extend it from Drive first.
            </p>

            {error && (
              <p className="text-xs px-3 py-2 rounded"
                style={{ backgroundColor: 'rgba(239,68,68,0.1)', color: '#ef4444' }}>
                {error}
              </p>
            )}

            <div className="flex gap-3">
              <button onClick={onClose} className="flex-1 py-2 rounded-lg text-sm"
                style={{ color: 'rgb(var(--fg-muted))' }}>
                Cancel
              </button>
              <button
                onClick={doUpdate}
                disabled={!content}
                className="flex-1 py-2 rounded-lg text-sm font-semibold disabled:opacity-40"
                style={{ backgroundColor: 'rgb(var(--accent))', color: '#fff' }}
              >
                Publish update
              </button>
            </div>
          </>
        )}

        {phase === 'updating' && (
          <div className="flex flex-col items-center gap-3 py-6">
            <RefreshCw size={20} className="animate-spin" style={{ color: 'rgb(var(--accent))' }} />
            <p className="text-sm" style={{ color: 'rgb(var(--fg-muted))' }}>Uploading and updating feed…</p>
          </div>
        )}

        {phase === 'done' && (
          <div className="space-y-4">
            <div className="flex items-center gap-3">
              <div className="w-7 h-7 rounded-full flex items-center justify-center shrink-0"
                style={{ backgroundColor: 'rgba(74,222,128,0.15)' }}>
                <Check size={14} color="#4ade80" />
              </div>
              <p className="text-sm font-medium">Feed updated</p>
            </div>
            {record.feedManifestAddress && (
              <div className="rounded-lg border p-3 space-y-2"
                style={{ backgroundColor: 'rgb(var(--bg))' }}>
                <p className="text-xs" style={{ color: 'rgb(var(--fg-muted))' }}>Feed address (unchanged)</p>
                <p className="font-mono text-xs break-all">{record.feedManifestAddress}</p>
                <div className="flex gap-2">
                  <button
                    onClick={() => {
                      navigator.clipboard.writeText(record.feedManifestAddress!)
                      setCopied(true)
                      setTimeout(() => setCopied(false), 2000)
                    }}
                    className="flex items-center gap-1.5 px-2 py-1 rounded text-xs transition-colors"
                    style={{ color: copied ? '#4ade80' : 'rgb(var(--fg-muted))' }}
                  >
                    {copied ? <Check size={11} /> : <Copy size={11} />}
                    {copied ? 'Copied' : 'Copy'}
                  </button>
                  <a
                    href={`${gatewayUrl}/bzz/${record.feedManifestAddress}/`}
                    target="_blank"
                    rel="noreferrer"
                    className="flex items-center gap-1.5 px-2 py-1 rounded text-xs"
                    style={{ color: 'rgb(var(--fg-muted))' }}
                  >
                    <ExternalLink size={11} />
                    Open
                  </a>
                </div>
              </div>
            )}
            <button onClick={onClose}
              className="w-full py-2 rounded-lg text-sm font-semibold border"
              style={{ backgroundColor: 'transparent', color: 'rgb(var(--fg))' }}>
              Done
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function isImageFile(name: string): boolean {
  return /\.(jpe?g|png|gif|webp|svg)$/i.test(name)
}

async function downloadFromSwarm(hash: string, filename: string) {
  const blob = await beeApi.downloadFile(hash)
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

// ─── Retrieve modal ───────────────────────────────────────────────────────────

function RetrieveModal({ onClose }: { onClose: () => void }) {
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
      const blob = await beeApi.downloadFile(h)
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = filename.trim() || h.slice(0, 12)
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Download failed')
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
        className="rounded-xl border p-6 w-96 space-y-5"
        style={{ backgroundColor: 'rgb(var(--bg-surface))' }}
        onClick={e => e.stopPropagation()}
      >
        <div>
          <p className="text-sm font-semibold">Retrieve from Swarm</p>
          <p className="text-xs mt-1" style={{ color: 'rgb(var(--fg-muted))' }}>
            Enter a Swarm hash to download the file.
          </p>
        </div>

        <div className="space-y-3">
          <div>
            <label className="text-xs uppercase tracking-widest block mb-1.5" style={{ color: 'rgb(var(--fg-muted))' }}>
              Swarm hash
            </label>
            <input
              type="text"
              value={hash}
              onChange={e => setHash(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && retrieve()}
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
        </div>

        {error && (
          <p className="text-xs px-3 py-2 rounded" style={{ backgroundColor: 'rgba(239,68,68,0.1)', color: '#ef4444' }}>
            {error}
          </p>
        )}

        <div className="flex gap-3">
          <button onClick={onClose} className="flex-1 py-2 rounded-lg text-sm" style={{ color: 'rgb(var(--fg-muted))' }}>
            Cancel
          </button>
          <button
            onClick={retrieve}
            disabled={loading || !hash.trim()}
            className="flex-1 py-2 rounded-lg text-sm font-semibold disabled:opacity-40 flex items-center justify-center gap-2"
            style={{ backgroundColor: 'rgb(var(--accent))', color: '#fff' }}
          >
            {loading ? <RefreshCw size={13} className="animate-spin" /> : <Download size={13} />}
            {loading ? 'Downloading…' : 'Download'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function Drive() {
  const navigate = useNavigate()
  const { records, remove } = useUploadHistory()
  const { gatewayUrl } = useAppStore()
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const [extendingId, setExtendingId] = useState<string | null>(null)
  const [updatingId, setUpdatingId] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [retrieveOpen, setRetrieveOpen] = useState(false)
  const [downloadingId, setDownloadingId] = useState<string | null>(null)

  const filteredRecords = search
    ? records.filter(r => r.name.toLowerCase().includes(search.toLowerCase()))
    : records

  function copyHash(id: string, hash: string) {
    navigator.clipboard.writeText(hash)
    setCopiedId(id)
    setTimeout(() => setCopiedId(null), 2000)
  }

  if (records.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-4 text-center p-6">
        <div
          className="w-12 h-12 rounded-full flex items-center justify-center"
          style={{ backgroundColor: 'rgb(var(--bg-surface))' }}
        >
          <Upload size={20} style={{ color: 'rgb(var(--fg-muted))' }} />
        </div>
        <div>
          <p className="text-sm font-medium">Nothing here yet</p>
          <p className="text-xs mt-1" style={{ color: 'rgb(var(--fg-muted))' }}>
            Files you publish will appear here
          </p>
        </div>
        <button
          onClick={() => navigate('/publish')}
          className="mt-2 px-4 py-2 rounded-lg text-sm font-semibold"
          style={{ backgroundColor: 'rgb(var(--accent))', color: '#fff' }}
        >
          Publish your first file
        </button>
      </div>
    )
  }

  const updatingRecord = records.find(r => r.id === updatingId)

  return (
    <div className="p-6">
      <div className="flex items-center gap-3 mb-6">
        <h1
          className="text-base font-semibold uppercase tracking-widest shrink-0"
          style={{ color: 'rgb(var(--fg-muted))' }}
        >
          Drive
        </h1>
        <div className="flex-1 relative">
          <Search size={11} className="absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none"
            style={{ color: 'rgb(var(--fg-muted))' }} />
          <input
            type="text"
            placeholder="Filter…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="w-full pl-7 pr-3 py-1.5 rounded-lg border text-xs focus:outline-none"
            style={{ backgroundColor: 'rgb(var(--bg-surface))', color: 'rgb(var(--fg))' }}
          />
        </div>
        <button
          onClick={() => setRetrieveOpen(true)}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs font-medium shrink-0 transition-colors"
          style={{ color: 'rgb(var(--fg-muted))' }}
        >
          <Download size={12} />
          Retrieve
        </button>
      </div>

      <div className="space-y-2">
        {filteredRecords.length === 0 && search && (
          <p className="text-xs text-center py-8" style={{ color: 'rgb(var(--fg-muted))' }}>
            No files match "{search}"
          </p>
        )}
        {filteredRecords.map(record => {
          const { label: expiry, urgent } = timeUntil(record.expiresAt)
          const linkHash = record.feedManifestAddress ?? record.hash
          return (
            <div
              key={record.id}
              className="rounded-lg border px-4 py-3 flex items-center gap-4"
              style={{ backgroundColor: 'rgb(var(--bg-surface))' }}
            >
              {/* Type icon or thumbnail */}
              <div
                className="w-8 h-8 rounded-lg overflow-hidden flex items-center justify-center shrink-0"
                style={{ backgroundColor: 'rgb(var(--bg))' }}
              >
                {record.type === 'file' && isImageFile(record.name) ? (
                  <img
                    src={`${getBeeUrl()}/bzz/${record.hash}`}
                    className="w-full h-full object-cover"
                    onError={e => { (e.target as HTMLImageElement).style.display = 'none' }}
                    alt=""
                  />
                ) : record.type === 'website' ? (
                  <Globe size={14} style={{ color: 'rgb(var(--fg-muted))' }} />
                ) : record.type === 'folder' ? (
                  <FolderOpen size={14} style={{ color: 'rgb(var(--fg-muted))' }} />
                ) : (
                  <File size={14} style={{ color: 'rgb(var(--fg-muted))' }} />
                )}
              </div>

              {/* Name + hash */}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <p className="text-sm font-medium truncate">{record.name}</p>
                  {record.hasFeed && (
                    <span
                      className="shrink-0 flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded font-medium"
                      style={{ backgroundColor: 'rgba(247,104,8,0.12)', color: 'rgb(var(--accent))' }}
                    >
                      <Rss size={9} />
                      Feed
                    </span>
                  )}
                </div>
                <p className="text-xs font-mono mt-0.5 truncate" style={{ color: 'rgb(var(--fg-muted))' }}>
                  {linkHash.slice(0, 20)}…
                </p>
              </div>

              {/* Size */}
              <span className="text-xs shrink-0 hidden sm:block" style={{ color: 'rgb(var(--fg-muted))' }}>
                {formatBytes(record.size)}
              </span>

              {/* Expiry */}
              <div className="flex flex-col items-end gap-1 shrink-0">
                <ExpiryBar expiresAt={record.expiresAt} uploadedAt={record.uploadedAt} />
                <span
                  className="text-[10px] uppercase tracking-widest font-semibold"
                  style={{ color: urgent ? '#ef4444' : 'rgb(var(--fg-muted))' }}
                >
                  {expiry}
                </span>
              </div>

              {/* Actions */}
              <div className="flex items-center gap-1 shrink-0">
                {urgent && (
                  <button
                    onClick={() => setExtendingId(record.id)}
                    className="px-2 py-1 rounded text-[10px] font-semibold uppercase tracking-widest"
                    style={{ backgroundColor: 'rgba(239,68,68,0.15)', color: '#ef4444' }}
                  >
                    Extend
                  </button>
                )}
                {record.hasFeed && (
                  <button
                    onClick={() => setUpdatingId(record.id)}
                    title="Publish update"
                    className="flex items-center gap-1 px-2 py-1 rounded text-[10px] font-semibold uppercase tracking-widest transition-colors"
                    style={{ backgroundColor: 'rgba(247,104,8,0.12)', color: 'rgb(var(--accent))' }}
                  >
                    <Rss size={9} />
                    Update
                  </button>
                )}
                <button
                  onClick={() => copyHash(record.id, linkHash)}
                  title="Copy link"
                  className="w-7 h-7 flex items-center justify-center rounded transition-colors"
                  style={{ color: copiedId === record.id ? '#4ade80' : 'rgb(var(--fg-muted))' }}
                >
                  <Copy size={13} />
                </button>
                <a
                  href={`${gatewayUrl}/bzz/${linkHash}/`}
                  target="_blank"
                  rel="noreferrer"
                  title="Open"
                  className="w-7 h-7 flex items-center justify-center rounded"
                  style={{ color: 'rgb(var(--fg-muted))' }}
                >
                  <ExternalLink size={13} />
                </a>
                <button
                  onClick={async () => {
                    setDownloadingId(record.id)
                    try { await downloadFromSwarm(record.hash, record.name) }
                    finally { setDownloadingId(null) }
                  }}
                  title="Download"
                  className="w-7 h-7 flex items-center justify-center rounded transition-colors"
                  style={{ color: 'rgb(var(--fg-muted))' }}
                >
                  {downloadingId === record.id
                    ? <RefreshCw size={13} className="animate-spin" />
                    : <Download size={13} />}
                </button>
                <button
                  onClick={() => remove(record.id)}
                  title="Remove from Drive"
                  className="w-7 h-7 flex items-center justify-center rounded transition-colors hover:text-red-400"
                  style={{ color: 'rgb(var(--fg-muted))' }}
                >
                  <Trash2 size={13} />
                </button>
              </div>
            </div>
          )
        })}
      </div>

      {extendingId && (
        <ExtendModal
          stampId={records.find(r => r.id === extendingId)?.stampId ?? ''}
          onClose={() => setExtendingId(null)}
        />
      )}

      {updatingRecord && (
        <UpdateFeedModal
          record={updatingRecord}
          onClose={() => setUpdatingId(null)}
        />
      )}

      {retrieveOpen && <RetrieveModal onClose={() => setRetrieveOpen(false)} />}
    </div>
  )
}
