import {
  ArrowLeft,
  Check,
  ChevronDown,
  ChevronRight,
  Clock,
  Copy,
  Download,
  ExternalLink,
  File,
  FolderOpen,
  FolderPlus,
  Globe,
  HardDrive,
  Lock,
  Pencil,
  Plus,
  RefreshCw,
  Rss,
  Search,
  Trash2,
  Upload,
} from 'lucide-react'
import { useQueryClient } from '@tanstack/react-query'
import React, { useEffect, useRef, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { useAccount } from 'wagmi'
import {
  beeApi,
  calcStampCost,
  depthToBytes,
  depthToCapacity,
  DURATION_PRESETS,
  getBeeUrl,
  plurToBzz,
  SIZE_PRESETS,
  topicFromString,
  type Stamp,
} from '../api/bee'
import { serverApi } from '../api/server'
import { useBuyStamp, useChainState, useStamps, useTopupStamp, useWallet } from '../api/queries'
import { useAppStore } from '../store/app'
import { useDerivedKey } from '../hooks/useDerivedKey'
import { useDriveMetadata } from '../hooks/useDriveMetadata'
import { useUploadHistory, type DriveFolder, type UploadRecord } from '../hooks/useUploadHistory'
import {
  detectIndexDocument,
  fileListToEntries,
  readDroppedDirectory,
  totalSize,
  type FileEntry,
} from '../utils/directory'
import ENSModal from '../components/ENSModal'
import WalletGate from '../components/WalletGate'

// ─── Helpers ──────────────────────────────────────────────────────────────────

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

function ttlToDays(seconds: number): string {
  const d = Math.floor(seconds / 86400)

  if (d <= 0) return '<1d'

  if (d < 30) return `${d}d`

  return `${Math.floor(d / 30)}mo`
}

function ttlColor(seconds: number): string {
  if (seconds < 7 * 86400) return '#ef4444'

  if (seconds < 30 * 86400) return '#f59e0b'

  return '#4ade80'
}

function isImageFile(name: string): boolean {
  return /\.(jpe?g|png|gif|webp|svg)$/i.test(name)
}

async function downloadFromSwarm(hash: string, filename: string, onProgress?: (pct: number) => void) {
  const blob = await beeApi.downloadFile(hash, onProgress)
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

async function pollStampUsable(id: string, onPhase?: (p: string) => void): Promise<void> {
  for (let i = 0; i < 30; i++) {
    const elapsed = i * 2
    onPhase?.(`Waiting for drive to be ready… ${elapsed > 0 ? `(${elapsed}s)` : ''}`.trim())
    try {
      const s = await beeApi.getStamp(id)

      if (s.usable) return
    } catch {
      // not yet confirmed
    }
    await new Promise(r => setTimeout(r, 2000))
  }
  throw new Error('Drive did not become ready. Please try again.')
}

// ─── PlanButton ────────────────────────────────────────────────────────────────

function PlanButton({ label, selected, onClick }: { label: string; selected: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="px-4 py-2 rounded-lg border text-sm font-medium transition-all"
      style={{
        borderColor: selected ? 'rgb(var(--accent))' : 'rgb(var(--border))',
        backgroundColor: selected ? 'rgba(247,104,8,0.08)' : 'rgb(var(--bg-surface))',
        color: selected ? 'rgb(var(--fg))' : 'rgb(var(--fg-muted))',
      }}
    >
      {label}
    </button>
  )
}

// ─── ExpiryBar ────────────────────────────────────────────────────────────────

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

// ─── BuyDriveModal ─────────────────────────────────────────────────────────────

function BuyDriveModal({
  onClose,
  onCreated,
}: {
  onClose: () => void
  onCreated?: (batchId: string, encrypted: boolean) => void
}) {
  const { data: chainState } = useChainState()
  const { data: wallet } = useWallet()
  const buyStamp = useBuyStamp()
  const { isConnected } = useAccount()
  const { derive } = useDerivedKey()

  const [driveName, setDriveName] = useState('')
  const [sizeIdx, setSizeIdx] = useState(1)
  const [durationIdx, setDurationIdx] = useState(1)
  const [isEncrypted, setIsEncrypted] = useState(false)
  const [buying, setBuying] = useState(false)
  const [buyDone, setBuyDone] = useState(false)
  const [buyError, setBuyError] = useState<string | null>(null)

  const selectedSize = SIZE_PRESETS[sizeIdx]
  const selectedDuration = DURATION_PRESETS[durationIdx]
  const cost = chainState ? calcStampCost(selectedSize.depth, selectedDuration.months, chainState.currentPrice) : null
  const bzzBalance = wallet ? Number(plurToBzz(wallet.bzzBalance)) : null
  const canAfford = cost && bzzBalance !== null ? bzzBalance >= Number(cost.bzzCost) : true

  async function doBuy() {
    if (!cost || !driveName.trim()) return

    // If encrypting, derive wallet key now (confirms wallet works + caches for later use)
    if (isEncrypted) {
      const derivedSigner = await derive()

      if (!derivedSigner) {
        setBuyError('Wallet signature required for encrypted drives')

        return
      }
    }

    setBuying(true)
    setBuyError(null)
    try {
      const result = await buyStamp.mutateAsync({
        amount: cost.amount,
        depth: selectedSize.depth,
        immutable: true,
        label: driveName.trim(),
      })

      // Save encrypted flag immediately (ACT grantee setup deferred to first upload
      // because the stamp isn't usable yet at this point — it needs on-chain confirmation)
      onCreated?.(result.batchID, isEncrypted)
      setBuyDone(true)
      setTimeout(() => {
        setBuyDone(false)
        onClose()
      }, 1500)
    } catch (err) {
      setBuyError(err instanceof Error ? err.message : 'Purchase failed')
    } finally {
      setBuying(false)
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
        <p className="text-sm font-semibold">New drive</p>

        {/* Name */}
        <div>
          <p className="text-xs uppercase tracking-widest mb-2" style={{ color: 'rgb(var(--fg-muted))' }}>
            Drive name <span style={{ color: '#ef4444' }}>*</span>
          </p>
          <input
            type="text"
            value={driveName}
            onChange={e => setDriveName(e.target.value)}
            placeholder="e.g. Website backup, Photos 2024…"
            className="w-full rounded-lg border px-3 py-2 text-sm focus:outline-none"
            style={{ backgroundColor: 'rgb(var(--bg))', color: 'rgb(var(--fg))' }}
            autoFocus
          />
        </div>

        {/* Size */}
        <div>
          <p className="text-xs uppercase tracking-widest mb-2" style={{ color: 'rgb(var(--fg-muted))' }}>
            Size
          </p>
          <div className="flex flex-wrap gap-2">
            {SIZE_PRESETS.map((s, i) => (
              <PlanButton key={s.label} label={s.label} selected={sizeIdx === i} onClick={() => setSizeIdx(i)} />
            ))}
          </div>
        </div>

        {/* Duration */}
        <div>
          <p className="text-xs uppercase tracking-widest mb-2" style={{ color: 'rgb(var(--fg-muted))' }}>
            Duration
          </p>
          <div className="flex flex-wrap gap-2">
            {DURATION_PRESETS.map((d, i) => (
              <PlanButton
                key={d.label}
                label={d.label}
                selected={durationIdx === i}
                onClick={() => setDurationIdx(i)}
              />
            ))}
          </div>
        </div>

        {/* Encrypt */}
        <label className="flex items-start gap-2 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={isEncrypted}
            onChange={e => setIsEncrypted(e.target.checked)}
            className="mt-0.5 accent-orange-500"
          />
          <div>
            <p className="text-xs font-medium">Encrypt this drive</p>
            <p className="text-xs" style={{ color: 'rgb(var(--fg-muted))' }}>
              Only you can read files on this drive. Requires wallet connection.
            </p>
          </div>
        </label>

        {isEncrypted && !isConnected && <WalletGate />}

        {/* Cost */}
        {cost && (
          <p className="text-sm">
            <span style={{ color: 'rgb(var(--fg-muted))' }}>Estimated cost: </span>
            <span className="font-semibold">{cost.bzzCost} BZZ</span>
            {!canAfford && !buying && !buyDone && (
              <span className="ml-2 text-xs" style={{ color: '#ef4444' }}>
                Insufficient BZZ
              </span>
            )}
          </p>
        )}

        <p className="text-xs" style={{ color: 'rgb(var(--fg-muted))' }}>
          Storage is funded upfront. You can extend the drive anytime before it expires.
        </p>

        {buyError && (
          <p className="text-xs" style={{ color: '#ef4444' }}>
            {buyError}
          </p>
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
            onClick={doBuy}
            disabled={buying || !cost || !canAfford || buyDone || !driveName.trim() || (isEncrypted && !isConnected)}
            className="flex-1 py-2 rounded-lg text-sm font-semibold disabled:opacity-40 flex items-center justify-center gap-2"
            style={{
              backgroundColor: buyDone ? 'rgba(74,222,128,0.15)' : 'rgb(var(--accent))',
              color: buyDone ? '#4ade80' : '#fff',
            }}
          >
            {buying && <RefreshCw size={13} className="animate-spin" />}
            {/* eslint-disable-next-line no-nested-ternary */}
            {buyDone ? 'Drive created!' : buying ? 'Creating…' : 'Create drive'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── ExtendModal ───────────────────────────────────────────────────────────────

function ExtendModal({ stamp, onClose }: { stamp: Stamp; onClose: () => void }) {
  const [durationIdx, setDurationIdx] = useState(1)
  const [extendError, setExtendError] = useState<string | null>(null)
  const { data: chainState } = useChainState()
  const topup = useTopupStamp()
  const queryClient = useQueryClient()

  const cost = chainState
    ? calcStampCost(stamp.depth, DURATION_PRESETS[durationIdx].months, chainState.currentPrice)
    : null

  async function doExtend() {
    if (!cost) return
    setExtendError(null)
    try {
      await topup.mutateAsync({ id: stamp.batchID, amount: cost.amount })
      queryClient.refetchQueries({ queryKey: ['bee', 'stamps'] })
      queryClient.refetchQueries({ queryKey: ['bee', 'wallet'] })
      onClose()
    } catch (err: any) {
      const msg =
        err?.response?.status === 402 || err?.message?.includes('402')
          ? 'Insufficient BZZ. Top up your wallet first.'
          : err?.message || 'Failed to extend drive.'
      setExtendError(msg)
    }
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
          <p className="text-sm font-semibold">Extend drive</p>
          <p className="text-xs mt-1" style={{ color: 'rgb(var(--fg-muted))' }}>
            {stamp.label || `${stamp.batchID.slice(0, 20)}…`}
          </p>
          <p className="text-xs mt-0.5" style={{ color: 'rgb(var(--fg-muted))' }}>
            {depthToCapacity(stamp.depth)} · {ttlToDays(stamp.batchTTL)} remaining
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

        {extendError && (
          <p className="text-xs" style={{ color: '#ef4444' }}>
            {extendError}
          </p>
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
            onClick={doExtend}
            disabled={topup.isPending || !cost}
            className="flex-1 py-2 rounded-lg text-sm font-semibold disabled:opacity-40"
            style={{ backgroundColor: 'rgb(var(--accent))', color: '#fff' }}
          >
            {topup.isPending ? 'Extending…' : 'Extend drive'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── UpdateFeedModal ───────────────────────────────────────────────────────────

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

  const { update } = useUploadHistory()

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
    if (!content) return
    setPhase('updating')
    setError(null)
    const stampId = record.driveId
    try {
      let reference: string

      if (record.type === 'file') {
        const res = await beeApi.uploadFile(content.entries[0].file, stampId)
        reference = res.reference
      } else {
        const opts =
          record.type === 'website' ? { indexDocument: content.indexDocument, errorDocument: '404.html' } : undefined
        const res = await beeApi.uploadCollection(content.entries, stampId, opts)
        reference = res.reference
      }

      const topicHex = await topicFromString(record.feedTopic ?? record.name)
      await serverApi.createFeedUpdate(topicHex, reference, stampId)
      update(record.id, { hash: reference })
      setPhase('done')
    } catch (err) {
      const raw = err instanceof Error ? err.message : ''
      const match = raw.match(/"message":"([^"]+)"/)
      setError(match ? match[1] : 'Could not publish the update. Please try again.')
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
            <div
              onDragOver={e => {
                e.preventDefault()
                setDragging(true)
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={handleDrop}
              onClick={() => (record.type === 'file' ? fileInputRef.current?.click() : dirInputRef.current?.click())}
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
            <input
              ref={dirInputRef}
              type="file"
              className="hidden"
              // @ts-expect-error — webkitdirectory not in TS types
              webkitdirectory="true"
              onChange={handleDirInput}
            />

            <p className="text-xs" style={{ color: 'rgb(var(--fg-muted))' }}>
              Uses existing storage. If the drive is expired or full, extend it first.
            </p>

            {error && (
              <p
                className="text-xs px-3 py-2 rounded"
                style={{ backgroundColor: 'rgba(239,68,68,0.1)', color: '#ef4444' }}
              >
                {error}
              </p>
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
            <p className="text-sm" style={{ color: 'rgb(var(--fg-muted))' }}>
              Uploading and updating feed…
            </p>
          </div>
        )}

        {phase === 'done' && (
          <div className="space-y-4">
            <div className="flex items-center gap-3">
              <div
                className="w-7 h-7 rounded-full flex items-center justify-center shrink-0"
                style={{ backgroundColor: 'rgba(74,222,128,0.15)' }}
              >
                <Check size={14} color="#4ade80" />
              </div>
              <p className="text-sm font-medium">Feed updated</p>
            </div>
            {record.feedManifestAddress && (
              <div className="rounded-lg border p-3 space-y-2" style={{ backgroundColor: 'rgb(var(--bg))' }}>
                <p className="text-xs" style={{ color: 'rgb(var(--fg-muted))' }}>
                  Feed address (unchanged)
                </p>
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
                    href={`${getBeeUrl()}/bzz/${record.feedManifestAddress}/`}
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
            <button
              onClick={onClose}
              className="w-full py-2 rounded-lg text-sm font-semibold border"
              style={{ backgroundColor: 'transparent', color: 'rgb(var(--fg))' }}
            >
              Done
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

// ─── RetrieveModal ─────────────────────────────────────────────────────────────

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
      let blob: Blob

      try {
        blob = await beeApi.downloadFile(h)
      } catch {
        // Manifest download failed — try raw bytes fallback
        blob = await beeApi.downloadBytes(h)
      }

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
        </div>

        {error && (
          <p className="text-xs px-3 py-2 rounded" style={{ backgroundColor: 'rgba(239,68,68,0.1)', color: '#ef4444' }}>
            {error}
          </p>
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

// ─── RecordRow ────────────────────────────────────────────────────────────────

interface RecordRowProps {
  record: UploadRecord
  copiedId: string | null
  downloadingId: string | null
  downloadPct: number | null
  gatewayUrl: string
  onCopy: (id: string, hash: string) => void
  onUpdate: (id: string) => void
  onDownload: (id: string, hash: string, name: string) => void
  onRemove: (id: string) => void
  onSetENS?: (id: string) => void
  onDragStart?: (e: React.DragEvent, id: string) => void
  onDragEnd?: () => void
}

function RecordRow({
  record,
  copiedId,
  downloadingId,
  downloadPct,
  gatewayUrl,
  onCopy,
  onUpdate,
  onDownload,
  onRemove,
  onSetENS,
  onDragStart,
  onDragEnd,
}: RecordRowProps) {
  const { label: expiry, urgent } = timeUntil(record.expiresAt)
  const linkHash = record.feedManifestAddress ?? record.hash

  return (
    <div
      draggable={Boolean(onDragStart)}
      onDragStart={onDragStart ? e => onDragStart(e, record.id) : undefined}
      onDragEnd={onDragEnd}
      className="px-2 py-2 flex items-center gap-3 transition-colors hover:bg-white/[0.02]"
    >
      {/* Type icon or thumbnail */}
      <div
        className="w-6 h-6 rounded overflow-hidden flex items-center justify-center shrink-0"
        style={{ backgroundColor: 'rgb(var(--bg))' }}
      >
        {record.type === 'file' && isImageFile(record.name) ? (
          <img
            src={`${getBeeUrl()}/bzz/${record.hash}`}
            className="w-full h-full object-cover"
            onError={e => {
              ;(e.target as HTMLImageElement).style.display = 'none'
            }}
            alt=""
          />
        ) : record.type === 'website' ? (
          <Globe size={12} style={{ color: 'rgb(var(--fg-muted))' }} />
        ) : record.type === 'folder' ? (
          <FolderOpen size={12} style={{ color: 'rgb(var(--fg-muted))' }} />
        ) : (
          <File size={12} style={{ color: 'rgb(var(--fg-muted))' }} />
        )}
      </div>

      {/* Name + feed badge */}
      <div className="flex items-center gap-2 flex-1 min-w-0">
        {record.type === 'folder' || record.type === 'website' ? (
          <a
            href={`${getBeeUrl()}/bzz/${linkHash}/`}
            target="_blank"
            rel="noreferrer"
            className="text-xs font-medium truncate hover:underline"
            style={{ color: 'rgb(var(--fg))' }}
          >
            {record.name}
          </a>
        ) : (
          <p className="text-xs font-medium truncate">{record.name}</p>
        )}
        {record.hasFeed && (
          <button
            onClick={() => onUpdate(record.id)}
            className="shrink-0 flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded font-medium transition-opacity hover:opacity-80"
            style={{ backgroundColor: 'rgba(247,104,8,0.12)', color: 'rgb(var(--accent))' }}
          >
            <RefreshCw size={9} />
            Update content
          </button>
        )}
        {record.ensDomain && (
          <a
            href={`https://${record.ensDomain}.limo`}
            target="_blank"
            rel="noreferrer"
            title={`${record.ensDomain}.limo`}
            className="shrink-0 flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded font-medium transition-opacity hover:opacity-80"
            style={{ backgroundColor: 'rgba(74,222,128,0.12)', color: '#4ade80' }}
          >
            {record.ensDomain}
            <ExternalLink size={8} />
          </a>
        )}
      </div>

      {/* Size */}
      <span
        className="text-xs shrink-0 hidden sm:block w-14 text-right tabular-nums"
        style={{ color: 'rgb(var(--fg-muted))' }}
      >
        {formatBytes(record.size)}
      </span>

      {/* Expiry */}
      <div className="flex items-center gap-2 shrink-0">
        <ExpiryBar expiresAt={record.expiresAt} uploadedAt={record.uploadedAt} />
        <span
          className="text-[10px] uppercase tracking-widest font-semibold w-16 text-right whitespace-nowrap"
          style={{ color: urgent ? '#ef4444' : 'rgb(var(--fg-muted))' }}
        >
          {expiry}
        </span>
      </div>

      {/* Actions */}
      <div className="flex items-center gap-0.5 shrink-0">
        {record.type === 'website' && onSetENS && (
          <button
            onClick={() => onSetENS(record.id)}
            title={record.ensDomain ? `Update ENS (${record.ensDomain})` : 'Set ENS domain'}
            className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium transition-colors mr-1"
            style={{ color: 'rgb(var(--fg-muted))' }}
          >
            <Globe size={11} />
            {record.ensDomain ? 'ENS' : 'Set ENS'}
          </button>
        )}
        <button
          onClick={() => onCopy(record.id, linkHash)}
          title="Copy link"
          className="w-6 h-6 flex items-center justify-center rounded transition-colors"
          style={{ color: copiedId === record.id ? '#4ade80' : 'rgb(var(--fg-muted))' }}
        >
          <Copy size={12} />
        </button>
        <a
          href={`${getBeeUrl()}/bzz/${linkHash}/`}
          target="_blank"
          rel="noreferrer"
          title="Open"
          className="w-6 h-6 flex items-center justify-center rounded"
          style={{ color: 'rgb(var(--fg-muted))' }}
        >
          <ExternalLink size={12} />
        </a>
        {downloadingId === record.id && downloadPct !== null ? (
          <span className="text-[10px] tabular-nums px-1 shrink-0" style={{ color: 'rgb(var(--accent))' }}>
            {downloadPct}%
          </span>
        ) : (
          <button
            onClick={() => onDownload(record.id, record.hash, record.name)}
            title="Download"
            className="w-6 h-6 flex items-center justify-center rounded transition-colors"
            style={{ color: 'rgb(var(--fg-muted))' }}
          >
            {downloadingId === record.id ? <RefreshCw size={12} className="animate-spin" /> : <Download size={12} />}
          </button>
        )}
        <button
          onClick={() => onRemove(record.id)}
          title="Remove from Drive"
          className="w-6 h-6 flex items-center justify-center rounded transition-colors hover:text-red-400"
          style={{ color: 'rgb(var(--fg-muted))' }}
        >
          <Trash2 size={12} />
        </button>
      </div>
    </div>
  )
}

// ─── DriveCard ─────────────────────────────────────────────────────────────────

interface DriveCardProps {
  stamp: Stamp
  records: UploadRecord[]
  folders: DriveFolder[]
  gatewayUrl: string
  copiedId: string | null
  downloadingId: string | null
  downloadPct: number | null
  customName?: string
  encrypted?: boolean
  granteeCount?: number
  onOpen: (folderId?: string) => void
  onExtend: () => void
  onRename: (name: string) => void
  onCopy: (id: string, hash: string) => void
  onUpdate: (id: string) => void
  onDownload: (id: string, hash: string, name: string) => void
  onRemove: (id: string) => void
  onSetENS: (id: string) => void
  onMoveToFolder: (recordId: string, folderId: string) => void
}

function DriveCard({
  stamp,
  records,
  folders,
  gatewayUrl,
  copiedId,
  downloadingId,
  downloadPct,
  customName,
  onOpen,
  onExtend,
  onRename,
  onCopy,
  onUpdate,
  onDownload,
  onRemove,
  onSetENS,
  encrypted,
  granteeCount,
  onMoveToFolder,
}: DriveCardProps) {
  const [expanded, setExpanded] = useState(false)
  const [expandedInlineFolders, setExpandedInlineFolders] = useState<Set<string>>(new Set())
  const [inlineDraggingId, setInlineDraggingId] = useState<string | null>(null)
  const [inlineDragOverFolderId, setInlineDragOverFolderId] = useState<string | null>(null)
  const [renaming, setRenaming] = useState(false)
  const [renameInput, setRenameInput] = useState('')
  const MAX_TTL = 365 * 24 * 3600
  const ttlPct = Math.min((stamp.batchTTL / MAX_TTL) * 100, 100)
  const color = ttlColor(stamp.batchTTL)
  const hasName = Boolean(customName || stamp.label)
  const driveName = customName || stamp.label || `${stamp.batchID.slice(0, 8)}…`
  const capacityBytes = depthToBytes(stamp.depth)
  const usedBytes = records.reduce((s, r) => s + r.size, 0)
  const maxUtilization = 1 << (stamp.depth - stamp.bucketDepth)
  const utilizationPct = Math.round((stamp.utilization / maxUtilization) * 100)
  const isFull = stamp.utilization >= maxUtilization
  const rootFolders = folders.filter(f => !f.parentFolderId)
  const rootFiles = records.filter(r => !r.folderId)
  const itemSummary = (() => {
    const parts = []

    if (rootFolders.length > 0) parts.push(`${rootFolders.length} folder${rootFolders.length !== 1 ? 's' : ''}`)

    if (rootFiles.length > 0) parts.push(`${rootFiles.length} file${rootFiles.length !== 1 ? 's' : ''}`)

    return parts.join(', ') || '0 files'
  })()

  const driveClickTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const folderClickTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())

  function handleDriveClick() {
    if (driveClickTimer.current !== null) {
      clearTimeout(driveClickTimer.current)
      driveClickTimer.current = null
      onOpen()

      return
    }
    driveClickTimer.current = setTimeout(() => {
      driveClickTimer.current = null
      setExpanded(v => !v)
    }, 300)
  }

  function handleFolderClick(id: string) {
    if (folderClickTimers.current.has(id)) {
      clearTimeout(folderClickTimers.current.get(id))
      folderClickTimers.current.delete(id)
      onOpen(id)

      return
    }
    const timer = setTimeout(() => {
      folderClickTimers.current.delete(id)
      setExpandedInlineFolders(prev => {
        const next = new Set(prev)

        if (next.has(id)) next.delete(id)
        else next.add(id)

        return next
      })
    }, 300)
    folderClickTimers.current.set(id, timer)
  }

  function renderInlineFolder(folder: DriveFolder, depth: number): React.ReactNode {
    const isExpanded = expandedInlineFolders.has(folder.id)
    const childFolders = folders.filter(f => f.parentFolderId === folder.id)
    const folderFiles = records.filter(r => r.folderId === folder.id)

    return (
      <div key={folder.id} style={{ paddingLeft: `${depth * 12}px` }}>
        <div
          onClick={() => handleFolderClick(folder.id)}
          onDragOver={e => {
            e.preventDefault()
            setInlineDragOverFolderId(folder.id)
          }}
          onDragLeave={e => {
            if (!e.currentTarget.contains(e.relatedTarget as Node)) setInlineDragOverFolderId(null)
          }}
          onDrop={e => {
            e.preventDefault()
            const recordId = e.dataTransfer.getData('recordId')

            // Only move if the record belongs to this drive (prevent cross-drive drops)
            if (recordId && records.find(r => r.id === recordId)) {
              onMoveToFolder(recordId, folder.id)
            }
            setInlineDragOverFolderId(null)
            setInlineDraggingId(null)
          }}
          className="flex items-center gap-2 px-2 py-1.5 rounded cursor-pointer select-none transition-colors hover:bg-white/[0.04]"
          style={{
            backgroundColor: inlineDragOverFolderId === folder.id ? 'rgba(247,104,8,0.08)' : undefined,
            outline: inlineDragOverFolderId === folder.id ? '2px solid rgb(var(--accent))' : 'none',
            outlineOffset: '-2px',
          }}
        >
          <span style={{ color: 'rgb(var(--fg-muted))' }}>
            {isExpanded ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
          </span>
          <FolderOpen size={11} style={{ color: 'rgb(var(--fg-muted))' }} />
          <span className="text-xs flex-1 truncate">{folder.name}</span>
        </div>
        {isExpanded && (
          <div className="ml-3 pl-2 border-l" style={{ borderColor: 'rgba(255,255,255,0.1)' }}>
            {childFolders.map(async child => renderInlineFolder(child, depth + 1))}
            {folderFiles.length > 0 && (
              <div className="divide-y" style={{ borderColor: 'rgb(var(--border))' }}>
                {folderFiles.map(r => (
                  <RecordRow
                    key={r.id}
                    record={r}
                    copiedId={copiedId}
                    downloadingId={downloadingId}
                    downloadPct={downloadPct}
                    gatewayUrl={gatewayUrl}
                    onCopy={onCopy}
                    onUpdate={onUpdate}
                    onDownload={onDownload}
                    onRemove={onRemove}
                    onSetENS={onSetENS}
                    onDragStart={(e, id) => {
                      e.dataTransfer.setData('recordId', id)
                      setInlineDraggingId(id)
                    }}
                    onDragEnd={() => {
                      setInlineDraggingId(null)
                      setInlineDragOverFolderId(null)
                    }}
                  />
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="border-b" style={{ borderColor: 'rgb(var(--border))' }}>
      <div
        className="flex items-center gap-3 px-4 py-3 hover:bg-[rgb(var(--bg-surface))] transition-colors"
        style={{ cursor: 'pointer' }}
        onClick={handleDriveClick}
      >
        {/* Expand chevron */}
        <span style={{ color: 'rgb(var(--fg-muted))' }}>
          {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        </span>
        {encrypted ? (
          <Lock size={14} className="shrink-0" style={{ color: 'rgb(var(--accent))' }} />
        ) : (
          <HardDrive size={14} className="shrink-0" style={{ color: 'rgb(var(--fg-muted))' }} />
        )}

        {/* Drive name — unnamed drives show a prompt; named drives show pencil on hover */}
        {renaming ? (
          <input
            autoFocus
            value={renameInput}
            onChange={e => setRenameInput(e.target.value)}
            onBlur={() => {
              const val = renameInput.trim()

              if (val) {
                onRename(val)
                setRenaming(false)
              } else if (hasName) setRenaming(false)
              // if no name and input empty, keep open
            }}
            onKeyDown={e => {
              if (e.key === 'Enter') {
                const val = renameInput.trim()

                if (val) {
                  onRename(val)
                  setRenaming(false)
                }
              }

              if (e.key === 'Escape' && hasName) setRenaming(false)
            }}
            onClick={e => e.stopPropagation()}
            placeholder="Name this drive…"
            className="text-sm font-medium bg-transparent border-b outline-none flex-1 min-w-0"
            style={{ borderColor: 'rgb(var(--accent))', color: 'rgb(var(--fg))' }}
          />
        ) : !hasName ? (
          <button
            onClick={e => {
              e.stopPropagation()
              setRenameInput('')
              setRenaming(true)
            }}
            className="text-sm flex-1 text-left min-w-0"
            style={{ color: 'rgb(var(--fg-muted))', fontStyle: 'italic' }}
          >
            Name this drive…
          </button>
        ) : (
          <span className="text-sm font-medium truncate flex-1 group/name flex items-center gap-1 min-w-0">
            <span className="truncate">{driveName}</span>
            <button
              onClick={e => {
                e.stopPropagation()
                setRenameInput(driveName)
                setRenaming(true)
              }}
              className="opacity-0 group-hover/name:opacity-100 transition-opacity shrink-0"
              style={{ color: 'rgb(var(--fg-muted))' }}
            >
              <Pencil size={10} />
            </button>
          </span>
        )}

        {/* Confirming badge */}
        {!stamp.usable && (
          <span
            className="text-[10px] px-1.5 py-0.5 rounded font-semibold uppercase tracking-widest animate-pulse shrink-0"
            style={{ backgroundColor: 'rgba(247,104,8,0.1)', color: 'rgb(var(--accent))' }}
          >
            Confirming…
          </span>
        )}

        {/* Encrypted badge */}
        {encrypted && (
          <span
            className="flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded font-medium shrink-0"
            style={{ backgroundColor: 'rgba(247,104,8,0.1)', color: 'rgb(var(--accent))' }}
          >
            <Lock size={9} />
            {granteeCount && granteeCount > 1 ? `${granteeCount - 1} shared` : 'Encrypted'}
          </span>
        )}

        {/* Website badge */}
        {records.some(r => r.type === 'website') && (
          <span
            className="flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded font-medium shrink-0"
            style={{ backgroundColor: 'rgba(74,222,128,0.1)', color: '#4ade80' }}
          >
            <Globe size={9} />
            Website
          </span>
        )}

        {/* Item count */}
        <span className="text-xs shrink-0" style={{ color: 'rgb(var(--fg-muted))' }}>
          {itemSummary}
        </span>

        {/* Storage usage + utilization */}
        <span className="text-xs shrink-0" style={{ color: 'rgb(var(--fg-muted))' }}>
          {usedBytes > 0 ? `${formatBytes(usedBytes)} / ${formatBytes(capacityBytes)}` : formatBytes(capacityBytes)}
        </span>

        {isFull && (
          <span
            className="text-[10px] font-semibold px-1.5 py-0.5 rounded shrink-0"
            style={{ backgroundColor: 'rgba(239,68,68,0.15)', color: '#ef4444' }}
          >
            Full
          </span>
        )}

        {/* TTL bar + label */}
        <div className="flex items-center gap-1.5 shrink-0" style={{ color }}>
          <Clock size={10} />
          <div className="w-16 h-1 rounded-full shrink-0" style={{ backgroundColor: 'rgb(var(--border))' }}>
            <div className="h-1 rounded-full" style={{ width: `${ttlPct}%`, backgroundColor: color }} />
          </div>
          <span className="text-[10px] w-10 text-right shrink-0">{ttlToDays(stamp.batchTTL)}</span>
        </div>

        {/* Extend */}
        <button
          onClick={e => {
            e.stopPropagation()
            onExtend()
          }}
          className="text-xs shrink-0 transition-colors"
          style={{ color: 'rgb(var(--fg-muted))' }}
          disabled={!stamp.usable}
        >
          Extend
        </button>
      </div>

      {/* Inline file preview — only rendered when expanded and there's content */}
      {expanded && (rootFolders.length > 0 || rootFiles.length > 0) && (
        <div className="border-t" style={{ borderColor: 'rgb(var(--border))' }}>
          <div className="py-2 px-6">
            {rootFolders.length > 0 && (
              <div className="space-y-0.5 mb-0.5">{rootFolders.map(async folder => renderInlineFolder(folder, 0))}</div>
            )}
            {rootFiles.length > 0 && (
              <div className="divide-y" style={{ borderColor: 'rgb(var(--border))' }}>
                {rootFiles.map(r => (
                  <RecordRow
                    key={r.id}
                    record={r}
                    copiedId={copiedId}
                    downloadingId={downloadingId}
                    downloadPct={downloadPct}
                    gatewayUrl={gatewayUrl}
                    onCopy={onCopy}
                    onUpdate={onUpdate}
                    onDownload={onDownload}
                    onRemove={onRemove}
                    onSetENS={onSetENS}
                    onDragStart={(e, id) => {
                      e.dataTransfer.setData('recordId', id)
                      setInlineDraggingId(id)
                    }}
                    onDragEnd={() => {
                      setInlineDraggingId(null)
                      setInlineDragOverFolderId(null)
                    }}
                  />
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Inline upload panel ───────────────────────────────────────────────────────

type UploadType = 'file' | 'folder'

interface AddFileProps {
  driveId: string
  onDone: () => void
  onAdd: (record: UploadRecord) => void
}

function generateFolderIndex(name: string, entries: FileEntry[]): FileEntry {
  const rows = entries.map(e => `<li><a href="${e.path}">${e.path}</a></li>`).join('\n')
  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>${name}</title>
<style>body{font-family:system-ui,sans-serif;max-width:800px;margin:40px auto;padding:0 20px}h1{font-weight:500;margin-bottom:20px}ul{list-style:none;padding:0}li{padding:6px 0;border-bottom:1px solid #eee}a{text-decoration:none;color:#0066cc}a:hover{text-decoration:underline}</style>
</head><body><h1>${name}</h1><ul>
${rows}
</ul></body></html>`
  // Use globalThis.File to avoid conflict with the lucide-react File icon import
  const FileClass = globalThis.File

  return { path: '_index.html', file: new FileClass([html], '_index.html', { type: 'text/html' }) }
}

function AddFilePanel({ driveId, onDone, onAdd }: AddFileProps) {
  const [phase, setPhase] = useState('')
  const [progress, setProgress] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [uploading, setUploading] = useState(false)
  const [dragging, setDragging] = useState(false)

  const fileInputRef = useRef<HTMLInputElement>(null)
  const dirInputRef = useRef<HTMLInputElement>(null)

  async function handleUpload(entries: FileEntry[], name: string, type: UploadType) {
    setUploading(true)
    setError(null)
    setProgress(null)

    // For folder uploads inject a generated directory listing so /bzz/{hash}/ resolves
    const uploadEntries = type === 'folder' ? [...entries, generateFolderIndex(name, entries)] : entries
    const indexDocument = type === 'folder' ? '_index.html' : undefined

    try {
      await pollStampUsable(driveId, setPhase)

      async function doUpload(attempt: number): Promise<string> {
        if (attempt > 1) {
          setPhase(`Finalising storage… (retry ${attempt - 1})`)
          await new Promise(r => setTimeout(r, 5000))
        }
        setPhase('Uploading…')
        setProgress(0)

        if (type === 'file') {
          const res = await beeApi.uploadFileWithProgress(entries[0].file, driveId, pct => setProgress(pct))

          return res.reference
        }

        const res = await beeApi.uploadCollectionWithProgress(uploadEntries, driveId, { indexDocument }, pct =>
          setProgress(pct),
        )

        return res.reference
      }

      let reference!: string
      for (let attempt = 1; attempt <= 4; attempt++) {
        try {
          reference = await doUpload(attempt)
          break
        } catch (err) {
          if (attempt === 4) throw err
        }
      }

      setProgress(null)

      let expiresAt: number
      try {
        const stamp = await beeApi.getStamp(driveId)
        expiresAt = Date.now() + stamp.batchTTL * 1000
      } catch {
        expiresAt = Date.now() + 3 * 30 * 24 * 60 * 60 * 1000
      }

      onAdd({
        id: crypto.randomUUID(),
        name,
        hash: reference,
        size: entries.reduce((sum, e) => sum + e.file.size, 0),
        type,
        driveId,
        expiresAt,
        uploadedAt: Date.now(),
        hasFeed: false,
      })

      onDone()
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Upload failed'

      if (msg.includes('402') || msg.toLowerCase().includes('overissued')) {
        setError('Drive is full. Create a new drive or extend this one.')
      } else {
        setError(msg)
      }

      setPhase('')
      setProgress(null)
    } finally {
      setUploading(false)
    }
  }

  function handleFileInput(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]

    if (!file) return
    void handleUpload([{ path: file.name, file }], file.name, 'file')
  }

  function handleDirInput(e: React.ChangeEvent<HTMLInputElement>) {
    if (!e.target.files?.length) return
    const { name, entries } = fileListToEntries(e.target.files)
    void handleUpload(entries, name, 'folder')
  }

  async function handleDrop(e: React.DragEvent) {
    e.preventDefault()
    setDragging(false)
    const item = e.dataTransfer.items[0]

    if (!item) return
    const fsEntry = item.webkitGetAsEntry?.()

    if (fsEntry?.isDirectory) {
      try {
        const { name, entries } = await readDroppedDirectory(item)
        void handleUpload(entries, name, 'folder')
      } catch {
        /* ignore */
      }
    } else {
      const file = e.dataTransfer.files[0]

      if (file) void handleUpload([{ path: file.name, file }], file.name, 'file')
    }
  }

  if (uploading) {
    return (
      <div
        className="max-w-xl rounded-xl border p-6 mb-4 space-y-3"
        style={{ backgroundColor: 'rgb(var(--bg-surface))', borderColor: 'rgb(var(--border))' }}
      >
        <div className="flex items-center gap-2">
          <RefreshCw size={13} className="animate-spin shrink-0" style={{ color: 'rgb(var(--accent))' }} />
          <p className="text-sm" style={{ color: 'rgb(var(--fg-muted))' }}>
            {phase || 'Preparing…'}
          </p>
        </div>
        {progress !== null && (
          <div className="h-1 rounded-full" style={{ backgroundColor: 'rgb(var(--border))' }}>
            <div
              className="h-1 rounded-full transition-all"
              style={{ width: `${progress}%`, backgroundColor: 'rgb(var(--accent))' }}
            />
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="max-w-xl mb-4 space-y-3">
      {/* Drop zone */}
      <div
        onDragOver={e => {
          e.preventDefault()
          setDragging(true)
        }}
        onDragLeave={e => {
          if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false)
        }}
        onDrop={handleDrop}
        className="rounded-xl border-2 border-dashed transition-colors"
        style={{
          borderColor: dragging ? 'rgb(var(--accent))' : 'rgb(var(--border))',
          backgroundColor: dragging ? 'rgba(247,104,8,0.04)' : 'transparent',
        }}
      >
        <div className="flex flex-col items-center gap-3 py-12 px-6 text-center">
          <Upload size={26} style={{ color: 'rgb(var(--fg-muted))' }} />
          <div>
            <p className="text-sm font-medium" style={{ color: 'rgb(var(--fg))' }}>
              Drop a file or folder here
            </p>
            <p className="text-xs mt-1" style={{ color: 'rgb(var(--fg-muted))' }}>
              or click to browse —{' '}
              <button
                onClick={() => fileInputRef.current?.click()}
                className="underline"
                style={{ color: 'rgb(var(--fg-muted))' }}
              >
                file
              </button>
              {' · '}
              <button
                onClick={() => dirInputRef.current?.click()}
                className="underline"
                style={{ color: 'rgb(var(--fg-muted))' }}
              >
                folder
              </button>
            </p>
          </div>
        </div>
      </div>

      {error && (
        <p
          className="text-xs px-3 py-2 rounded text-center"
          style={{ backgroundColor: 'rgba(239,68,68,0.1)', color: '#ef4444' }}
        >
          {error}
        </p>
      )}

      <button onClick={onDone} className="text-xs" style={{ color: 'rgb(var(--fg-muted))' }}>
        Cancel
      </button>

      <input ref={fileInputRef} type="file" className="hidden" onChange={handleFileInput} />
      <input
        ref={dirInputRef}
        type="file"
        className="hidden"
        // @ts-expect-error — webkitdirectory not in TS types
        webkitdirectory="true"
        onChange={handleDirInput}
      />
    </div>
  )
}

// ─── Main component ────────────────────────────────────────────────────────────

export default function Drive() {
  const { data: stamps } = useStamps()
  const {
    records,
    folders,
    add: addRecord,
    remove,
    update: updateRecord,
    addFolder,
    removeFolder,
    renameFolder,
    moveToFolder,
    setEnsDomain,
  } = useUploadHistory()
  const { gatewayUrl } = useAppStore()
  const location = useLocation()
  const driveMetadata = useDriveMetadata()

  const [customDriveLabels, setCustomDriveLabels] = useState<Record<string, string>>(() => {
    try {
      return JSON.parse(localStorage.getItem('nook-drive-labels') ?? '{}')
    } catch {
      return {}
    }
  })

  function renameDrive(batchID: string, name: string) {
    setCustomDriveLabels(prev => {
      const next = { ...prev, [batchID]: name }
      localStorage.setItem('nook-drive-labels', JSON.stringify(next))

      return next
    })
  }

  const [activeDriveId, setActiveDriveId] = useState<string | null>(null)
  const [showBuyModal, setShowBuyModal] = useState(false)
  const [showExtendModal, setShowExtendModal] = useState<string | null>(null) // batchID
  const [addingFile, setAddingFile] = useState(false)
  const [search, setSearch] = useState('')
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const [downloadingId, setDownloadingId] = useState<string | null>(null)
  const [downloadPct, setDownloadPct] = useState<number | null>(null)
  const [updatingId, setUpdatingId] = useState<string | null>(null)
  const [retrieveOpen, setRetrieveOpen] = useState(false)
  const [ensRecordId, setEnsRecordId] = useState<string | null>(null)

  // Folder UI state
  const [openFolderId, setOpenFolderId] = useState<string | null>(null)
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set())
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [dragOverId, setDragOverId] = useState<string | 'root' | null>(null)
  const [renamingFolderId, setRenamingFolderId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [creatingFolder, setCreatingFolder] = useState(false)
  const [newFolderName, setNewFolderName] = useState('')

  // Reset on sidebar click
  useEffect(() => {
    setActiveDriveId(null)
    setAddingFile(false)
    setSearch('')
    setOpenFolderId(null)
    setExpandedFolders(new Set())
    // eslint-disable-next-line
  }, [location.key])

  const allStamps = stamps ?? []

  function copyHash(id: string, hash: string) {
    navigator.clipboard.writeText(`${gatewayUrl}/bzz/${hash}/`)
    setCopiedId(id)
    setTimeout(() => setCopiedId(null), 2000)
  }

  async function handleDownload(id: string, hash: string, name: string) {
    setDownloadingId(id)
    setDownloadPct(0)
    try {
      await downloadFromSwarm(hash, name, pct => setDownloadPct(pct))
    } finally {
      setDownloadingId(null)
      setDownloadPct(null)
    }
  }

  const activeDrive = activeDriveId ? allStamps.find(s => s.batchID === activeDriveId) : null
  const driveRecords = activeDriveId ? records.filter(r => r.driveId === activeDriveId) : []

  const updatingRecord = records.find(r => r.id === updatingId)
  const extendingStamp = showExtendModal ? allStamps.find(s => s.batchID === showExtendModal) : null

  // Search: flat list across active drives only (exclude expired stamps)
  const activeBatchIds = new Set(allStamps.map(s => s.batchID))
  const searchResults = search
    ? records.filter(r => r.name.toLowerCase().includes(search.toLowerCase()) && activeBatchIds.has(r.driveId))
    : []

  // ── Root view ────────────────────────────────────────────────────────────────

  if (!activeDriveId) {
    return (
      <div className="p-6">
        {/* Header */}
        <div className="flex items-center gap-3 mb-6">
          <div className="relative w-full max-w-[500px]">
            <Search
              size={11}
              className="absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none"
              style={{ color: 'rgb(var(--fg-muted))' }}
            />
            <input
              type="text"
              placeholder="Search all files…"
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="w-full pl-7 pr-3 py-1.5 rounded-lg border text-xs focus:outline-none"
              style={{ backgroundColor: 'rgb(var(--bg-surface))', color: 'rgb(var(--fg))' }}
            />
          </div>

          <div className="flex-1" />

          <button
            onClick={() => setRetrieveOpen(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs font-medium shrink-0 transition-colors"
            style={{ color: 'rgb(var(--fg-muted))' }}
          >
            <Download size={12} />
            Retrieve
          </button>

          <button
            onClick={() => setShowBuyModal(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold shrink-0"
            style={{ backgroundColor: 'rgb(var(--accent))', color: '#fff' }}
          >
            <Plus size={12} />
            New drive
          </button>
        </div>

        {/* Search results */}
        {search ? (
          <div>
            {searchResults.length === 0 ? (
              <p className="text-xs text-center py-8" style={{ color: 'rgb(var(--fg-muted))' }}>
                No files match "{search}"
              </p>
            ) : (
              <div className="divide-y" style={{ borderColor: 'rgb(var(--border))' }}>
                {searchResults.map(record => (
                  <RecordRow
                    key={record.id}
                    record={record}
                    copiedId={copiedId}
                    downloadingId={downloadingId}
                    downloadPct={downloadPct}
                    gatewayUrl={gatewayUrl}
                    onCopy={copyHash}
                    onUpdate={setUpdatingId}
                    onDownload={handleDownload}
                    onRemove={remove}
                    onSetENS={setEnsRecordId}
                  />
                ))}
              </div>
            )}
          </div>
        ) : stamps === undefined ? null : allStamps.length === 0 ? (
          /* Empty state */
          <div className="flex flex-col items-center justify-center py-20 gap-4 text-center">
            <div
              className="w-12 h-12 rounded-full flex items-center justify-center"
              style={{ backgroundColor: 'rgb(var(--bg-surface))' }}
            >
              <HardDrive size={20} style={{ color: 'rgb(var(--fg-muted))' }} />
            </div>
            <div>
              <p className="text-sm font-medium">No drives yet</p>
              <p className="text-xs mt-1" style={{ color: 'rgb(var(--fg-muted))' }}>
                Create a drive to start storing files.
              </p>
            </div>
            <button
              onClick={() => setShowBuyModal(true)}
              className="mt-2 px-4 py-2 rounded-lg text-sm font-semibold"
              style={{ backgroundColor: 'rgb(var(--accent))', color: '#fff' }}
            >
              New drive
            </button>
          </div>
        ) : (
          /* Drive list */
          <div className="border-t" style={{ borderColor: 'rgb(var(--border))' }}>
            {allStamps.map(stamp => (
              <DriveCard
                key={stamp.batchID}
                stamp={stamp}
                records={records.filter(r => r.driveId === stamp.batchID)}
                folders={folders.filter(f => f.driveId === stamp.batchID)}
                gatewayUrl={gatewayUrl}
                copiedId={copiedId}
                downloadingId={downloadingId}
                downloadPct={downloadPct}
                customName={customDriveLabels[stamp.batchID]}
                encrypted={driveMetadata.isEncrypted(stamp.batchID)}
                granteeCount={driveMetadata.get(stamp.batchID)?.granteeCount}
                onOpen={folderId => {
                  setActiveDriveId(stamp.batchID)

                  if (folderId) setOpenFolderId(folderId)
                }}
                onExtend={() => setShowExtendModal(stamp.batchID)}
                onRename={name => renameDrive(stamp.batchID, name)}
                onCopy={copyHash}
                onUpdate={setUpdatingId}
                onDownload={handleDownload}
                onRemove={remove}
                onSetENS={setEnsRecordId}
                onMoveToFolder={moveToFolder}
              />
            ))}
          </div>
        )}

        {showBuyModal && (
          <BuyDriveModal
            onClose={() => setShowBuyModal(false)}
            onCreated={(batchId, encrypted) => {
              if (encrypted) {
                driveMetadata.set(batchId, { encrypted: true })
              }
            }}
          />
        )}
        {extendingStamp && <ExtendModal stamp={extendingStamp} onClose={() => setShowExtendModal(null)} />}
        {updatingRecord && <UpdateFeedModal record={updatingRecord} onClose={() => setUpdatingId(null)} />}
        {retrieveOpen && <RetrieveModal onClose={() => setRetrieveOpen(false)} />}
        {ensRecordId &&
          (() => {
            const rec = records.find(r => r.id === ensRecordId)

            if (!rec) return null

            return (
              <ENSModal
                isOpen
                onClose={() => setEnsRecordId(null)}
                swarmHash={rec.hash}
                feedManifest={rec.feedManifestAddress}
                currentDomain={rec.ensDomain}
                onLinked={domain => {
                  setEnsDomain(ensRecordId, domain)
                  setEnsRecordId(null)
                }}
              />
            )
          })()}
      </div>
    )
  }

  // ── Folder helpers ───────────────────────────────────────────────────────────

  function toggleFolder(id: string) {
    setExpandedFolders(prev => {
      const next = new Set(prev)

      if (next.has(id)) next.delete(id)
      else next.add(id)

      return next
    })
  }

  function startRename(folder: DriveFolder) {
    setRenamingFolderId(folder.id)
    setRenameValue(folder.name)
  }

  function commitRename() {
    if (renamingFolderId && renameValue.trim()) {
      renameFolder(renamingFolderId, renameValue.trim())
    }
    setRenamingFolderId(null)
    setRenameValue('')
  }

  function commitNewFolder() {
    if (newFolderName.trim() && activeDriveId) {
      addFolder(newFolderName.trim(), activeDriveId, openFolderId ?? undefined)
    }
    setCreatingFolder(false)
    setNewFolderName('')
  }

  function handleFolderDrop(e: React.DragEvent, folderId: string) {
    e.preventDefault()
    const recordId = e.dataTransfer.getData('recordId')

    if (recordId) moveToFolder(recordId, folderId)
    setDragOverId(null)
    setDraggingId(null)
  }

  function handleRootDrop(e: React.DragEvent) {
    e.preventDefault()
    const recordId = e.dataTransfer.getData('recordId')

    if (recordId) moveToFolder(recordId, null)
    setDragOverId(null)
    setDraggingId(null)
  }

  function handleRecordDragStart(e: React.DragEvent, id: string) {
    e.dataTransfer.setData('recordId', id)
    setDraggingId(id)
  }

  const commonRowProps = {
    copiedId,
    downloadingId,
    downloadPct,
    gatewayUrl,
    onCopy: copyHash,
    onUpdate: setUpdatingId,
    onDownload: handleDownload,
    onRemove: remove,
    onSetENS: setEnsRecordId,
    onDragStart: handleRecordDragStart,
    onDragEnd: () => {
      setDraggingId(null)
      setDragOverId(null)
    },
  }

  function renderFolder(folder: DriveFolder, depth: number): React.ReactNode {
    const isOver = dragOverId === folder.id
    const isExpanded = expandedFolders.has(folder.id)
    const childFolders = folders.filter(f => f.parentFolderId === folder.id)
    const folderRecords = driveRecords.filter(r => r.folderId === folder.id)
    const count = folderRecords.length + childFolders.length
    const py = depth === 0 ? 'py-2.5' : 'py-2'

    return (
      <div key={folder.id}>
        <div
          onClick={() => {
            if (renamingFolderId !== folder.id) toggleFolder(folder.id)
          }}
          onDoubleClick={() => {
            if (renamingFolderId !== folder.id) setOpenFolderId(folder.id)
          }}
          onDragOver={e => {
            e.preventDefault()
            setDragOverId(folder.id)
          }}
          onDragLeave={e => {
            if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOverId(null)
          }}
          onDrop={e => handleFolderDrop(e, folder.id)}
          className={`rounded-lg border px-4 ${py} flex items-center gap-2 cursor-pointer select-none transition-colors`}
          style={{
            backgroundColor: isOver ? 'rgba(247,104,8,0.08)' : 'rgb(var(--bg-surface))',
            borderColor: isOver ? 'rgb(var(--accent))' : 'rgb(var(--border))',
            outline: isOver ? '2px solid rgb(var(--accent))' : 'none',
            outlineOffset: '-2px',
          }}
        >
          <span style={{ color: 'rgb(var(--fg-muted))' }}>
            {isExpanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          </span>
          <FolderOpen size={13} style={{ color: 'rgb(var(--fg-muted))' }} />
          {renamingFolderId === folder.id ? (
            <input
              type="text"
              autoFocus
              value={renameValue}
              onClick={e => e.stopPropagation()}
              onChange={e => setRenameValue(e.target.value)}
              onKeyDown={e => {
                e.stopPropagation()

                if (e.key === 'Enter') commitRename()

                if (e.key === 'Escape') {
                  setRenamingFolderId(null)
                  setRenameValue('')
                }
              }}
              onBlur={commitRename}
              className="flex-1 bg-transparent text-sm focus:outline-none"
              style={{ color: 'rgb(var(--fg))' }}
            />
          ) : (
            <span className="flex-1 text-sm font-medium">{folder.name}</span>
          )}
          <span className="text-xs" style={{ color: 'rgb(var(--fg-muted))' }}>
            {count > 0 ? count : ''}
          </span>
          <button
            onClick={e => {
              e.stopPropagation()
              startRename(folder)
            }}
            title="Rename"
            className="w-6 h-6 flex items-center justify-center rounded transition-colors"
            style={{ color: 'rgb(var(--fg-muted))' }}
          >
            <Pencil size={11} />
          </button>
          <button
            onClick={e => {
              e.stopPropagation()
              removeFolder(folder.id, folders)
            }}
            title="Delete folder"
            className="w-6 h-6 flex items-center justify-center rounded hover:text-red-400 transition-colors"
            style={{ color: 'rgb(var(--fg-muted))' }}
          >
            <Trash2 size={11} />
          </button>
        </div>

        {isExpanded && (
          <div className="mt-1 pl-4 space-y-1">
            {childFolders.map(async child => renderFolder(child, depth + 1))}
            {folderRecords.length > 0 && (
              <div className="divide-y" style={{ borderColor: 'rgb(var(--border))' }}>
                {folderRecords.map(record => (
                  <RecordRow key={record.id} record={record} {...commonRowProps} />
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    )
  }

  // ── Drive view ───────────────────────────────────────────────────────────────

  const driveName = activeDrive?.label || (activeDriveId ? `${activeDriveId.slice(0, 8)}…` : 'Drive')

  // Folders and records scoped to the active drive + current folder view
  const driveFolders = folders.filter(f => f.driveId === activeDriveId)
  const openFolder = openFolderId ? (driveFolders.find(f => f.id === openFolderId) ?? null) : null
  const visibleFolders = openFolderId
    ? driveFolders.filter(f => f.parentFolderId === openFolderId)
    : driveFolders.filter(f => !f.parentFolderId)
  const visibleRecords = openFolderId
    ? driveRecords.filter(r => r.folderId === openFolderId)
    : driveRecords.filter(r => !r.folderId)

  return (
    <div className="p-6">
      {/* Breadcrumb */}
      {openFolderId ? (
        <div className="flex items-center gap-2 mb-6">
          <button
            onClick={() => {
              setOpenFolderId(null)
              setCreatingFolder(false)
            }}
            className="flex items-center gap-1.5 text-xs transition-colors"
            style={{ color: 'rgb(var(--fg-muted))' }}
          >
            <ArrowLeft size={13} />
            {driveName}
          </button>
          <span style={{ color: 'rgb(var(--fg-muted))' }}>/</span>
          <span className="flex-1 text-sm font-medium">{openFolder?.name}</span>
          <button
            onClick={() => setAddingFile(v => !v)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold shrink-0"
            style={{ backgroundColor: 'rgb(var(--accent))', color: '#fff' }}
          >
            <Upload size={12} />
            Upload
          </button>
          <button
            onClick={() => {
              setCreatingFolder(true)
              setNewFolderName('')
            }}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs font-medium shrink-0"
            style={{ color: 'rgb(var(--fg-muted))' }}
          >
            <FolderPlus size={12} />
            New subfolder
          </button>
        </div>
      ) : (
        <div className="flex items-center gap-2 mb-6">
          <button
            onClick={() => {
              setActiveDriveId(null)
              setAddingFile(false)
            }}
            className="flex items-center gap-1.5 text-xs transition-colors"
            style={{ color: 'rgb(var(--fg-muted))' }}
          >
            <ArrowLeft size={13} />
            Drive
          </button>
          <span style={{ color: 'rgb(var(--fg-muted))' }}>/</span>
          <span className="flex-1 text-sm font-medium">{driveName}</span>
          <button
            onClick={() => setAddingFile(v => !v)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold shrink-0"
            style={{ backgroundColor: 'rgb(var(--accent))', color: '#fff' }}
          >
            <Upload size={12} />
            Upload
          </button>
          <button
            onClick={() => {
              setCreatingFolder(true)
              setNewFolderName('')
            }}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs font-medium shrink-0"
            style={{ color: 'rgb(var(--fg-muted))' }}
          >
            <FolderPlus size={12} />
            Folder
          </button>
        </div>
      )}

      {/* Inline upload panel */}
      {addingFile && (
        <AddFilePanel
          driveId={activeDriveId}
          onDone={() => setAddingFile(false)}
          onAdd={record => {
            addRecord({ ...record, folderId: openFolderId ?? undefined })
          }}
        />
      )}

      {/* New folder inline input */}
      {creatingFolder && (
        <div
          className="rounded-lg border px-4 py-2.5 flex items-center gap-3 mb-3"
          style={{ backgroundColor: 'rgb(var(--bg-surface))', borderColor: 'rgb(var(--border))' }}
        >
          <FolderPlus size={14} style={{ color: 'rgb(var(--fg-muted))' }} />
          <input
            type="text"
            autoFocus
            value={newFolderName}
            onChange={e => setNewFolderName(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') commitNewFolder()

              if (e.key === 'Escape') {
                setCreatingFolder(false)
                setNewFolderName('')
              }
            }}
            onBlur={commitNewFolder}
            placeholder={openFolderId ? 'Subfolder name…' : 'Folder name…'}
            className="flex-1 bg-transparent text-sm focus:outline-none"
            style={{ color: 'rgb(var(--fg))' }}
          />
          <span className="text-xs" style={{ color: 'rgb(var(--fg-muted))' }}>
            Enter to confirm
          </span>
        </div>
      )}

      {/* Folder tree */}
      {visibleFolders.length > 0 && (
        <div className="space-y-1 mb-3">{visibleFolders.map(async folder => renderFolder(folder, 0))}</div>
      )}

      {/* Files / folder separator */}
      {visibleFolders.length > 0 && visibleRecords.length > 0 && (
        <div className="flex items-center gap-2 px-1 py-2">
          <div className="h-px flex-1" style={{ backgroundColor: 'rgb(var(--border))' }} />
          <span
            className="text-[10px] uppercase tracking-widest font-semibold px-1"
            style={{ color: 'rgb(var(--fg-muted))' }}
          >
            Files
          </span>
          <div className="h-px flex-1" style={{ backgroundColor: 'rgb(var(--border))' }} />
        </div>
      )}

      {/* File list */}
      {visibleRecords.length > 0 ? (
        <div
          onDragOver={
            !openFolderId
              ? e => {
                  e.preventDefault()
                  setDragOverId('root')
                }
              : undefined
          }
          onDragLeave={
            !openFolderId
              ? e => {
                  if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOverId(null)
                }
              : undefined
          }
          onDrop={!openFolderId ? handleRootDrop : undefined}
          className="divide-y"
          style={{ borderColor: 'rgb(var(--border))' }}
        >
          {visibleRecords.map(record => (
            <RecordRow key={record.id} record={record} {...commonRowProps} />
          ))}
        </div>
      ) : visibleFolders.length === 0 && !addingFile && !creatingFolder ? (
        openFolderId ? (
          <div
            className="rounded-lg border-2 border-dashed px-4 py-10 text-center"
            style={{ borderColor: 'rgb(var(--border))' }}
          >
            <p className="text-sm" style={{ color: 'rgb(var(--fg-muted))' }}>
              This folder is empty
            </p>
            <p className="text-xs mt-1" style={{ color: 'rgb(var(--fg-muted))' }}>
              Upload files or drag them here from the drive
            </p>
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center py-16 gap-3 text-center">
            <p className="text-sm" style={{ color: 'rgb(var(--fg-muted))' }}>
              This drive is empty.
            </p>
            <p className="text-xs" style={{ color: 'rgb(var(--fg-muted))' }}>
              Upload a file or create a folder.
            </p>
          </div>
        )
      ) : null}

      {updatingRecord && <UpdateFeedModal record={updatingRecord} onClose={() => setUpdatingId(null)} />}
      {retrieveOpen && <RetrieveModal onClose={() => setRetrieveOpen(false)} />}
      {ensRecordId &&
        (() => {
          const rec = records.find(r => r.id === ensRecordId)

          if (!rec) return null

          return (
            <ENSModal
              isOpen
              onClose={() => setEnsRecordId(null)}
              swarmHash={rec.hash}
              feedManifest={rec.feedManifestAddress}
              currentDomain={rec.ensDomain}
              onLinked={domain => {
                setEnsDomain(ensRecordId, domain)
                setEnsRecordId(null)
              }}
            />
          )
        })()}
    </div>
  )
}
