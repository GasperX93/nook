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
  MoreVertical,
  PanelLeft,
  Pencil,
  Plus,
  RefreshCw,
  Rss,
  Search,
  Share2,
  Trash2,
  Upload,
  Users,
  X,
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
import { useAddresses, useBuyStamp, useChainState, useStamps, useWallet } from '../api/queries'
import { useAppStore } from '../store/app'
import { useDerivedKey } from '../hooks/useDerivedKey'
import { useDriveMetadata } from '../hooks/useDriveMetadata'
import { useSharedDrives } from '../hooks/useSharedDrives'
import { useUploadHistory, type DriveFolder, type UploadRecord } from '../hooks/useUploadHistory'
import {
  detectIndexDocument,
  fileListToEntries,
  readDroppedDirectory,
  totalSize,
  type FileEntry,
} from '../utils/directory'
import AddSharedDriveModal from '../components/AddSharedDriveModal'
import ENSModal from '../components/ENSModal'
import ShareModal from '../components/ShareModal'
import { Switch } from '../components/ui/switch'
import { Tabs, TabsList, TabsTrigger } from '../components/ui/tabs'
import { useSidebar } from '../components/ui/sidebar'

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

  if (d < 365) return `${d}d`

  return `${Math.floor(d / 365)}y`
}

function ttlColor(seconds: number): string {
  if (seconds < 7 * 86400) return '#ef4444'

  if (seconds < 30 * 86400) return '#f59e0b'

  return '#4ade80'
}

function isImageFile(name: string): boolean {
  return /\.(jpe?g|png|gif|webp|svg)$/i.test(name)
}

async function downloadFromSwarm(
  hash: string,
  filename: string,
  onProgress?: (pct: number) => void,
  actOptions?: { actPublisher: string; actHistoryRef: string },
) {
  const blob = actOptions
    ? await beeApi.downloadFileWithACT(hash, actOptions.actPublisher, actOptions.actHistoryRef, onProgress)
    : await beeApi.downloadFile(hash, onProgress)
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
  const [sizeIdx, setSizeIdx] = useState(0)
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

    // TODO: re-enable when metadata feeds are wired up
    // if (isEncrypted) {
    //   const derivedSigner = await derive()
    //   if (!derivedSigner) {
    //     setBuyError('Wallet signature required for encrypted drives')
    //     return
    //   }
    // }

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
      onClick={() => {
        if (!buying && !buyDone) onClose()
      }}
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
              Files on this drive are encrypted. You can share access with others.
            </p>
          </div>
        </label>

        {/* TODO: re-enable when metadata feeds are wired up */}
        {/* {isEncrypted && !isConnected && <WalletGate />} */}

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
            disabled={buying || !cost || !canAfford || buyDone || !driveName.trim()}
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
  // Capacity options: only depths strictly larger than current AND only when the
  // user-facing capacity is also larger. With Nook's overbuy, a legacy depth-19
  // "110 MB" stamp shouldn't see "110 MB (depth 21)" as an extend option — same
  // displayed capacity, just a more expensive same-label drive.
  const currentDisplayBytes = depthToBytes(stamp.depth)
  const capacityOptions = SIZE_PRESETS.filter(s => s.depth > stamp.depth && depthToBytes(s.depth) > currentDisplayBytes)
  const [capacityEnabled, setCapacityEnabled] = useState(false)
  const [capacityIdx, setCapacityIdx] = useState(0)
  const [durationEnabled, setDurationEnabled] = useState(false)
  const [durationIdx, setDurationIdx] = useState(0)
  const [extendError, setExtendError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const { data: chainState } = useChainState()
  const { data: wallet } = useWallet()
  const queryClient = useQueryClient()

  const targetDepth = capacityEnabled && capacityOptions[capacityIdx] ? capacityOptions[capacityIdx].depth : stamp.depth
  const willDilute = capacityEnabled && targetDepth > stamp.depth
  const userExtendMonths = durationEnabled ? DURATION_PRESETS[durationIdx].months : 0

  // Compute the topup amount that, combined with the dilute (if any), produces:
  //   - the user's current remaining TTL (preserved across the dilute halving), plus
  //   - the additional months the user picked under "Extend duration"
  //
  // Math: per Bee protocol, each +1 depth in dilute halves remaining time. To restore
  // it we need to top up enough to undo that halving. Then we add any user-requested
  // duration on top.
  const SECONDS_PER_MONTH = 30 * 86400
  const SECONDS_PER_BLOCK = 5 // Gnosis chain
  const depthDelta = targetDepth - stamp.depth
  const recoverySeconds = depthDelta > 0 ? Math.floor(stamp.batchTTL * (1 - 1 / 2 ** depthDelta)) : 0
  const extendSeconds = userExtendMonths * SECONDS_PER_MONTH
  const totalSecondsToBuy = recoverySeconds + extendSeconds

  // Cost = price-per-block × blocks × chunks-at-new-depth. Hidden from the user how it
  // breaks down between dilute-recovery and user-requested time — they see one number.
  const cost = (() => {
    if (totalSecondsToBuy <= 0 || !chainState) return null
    const blocks = BigInt(Math.floor(totalSecondsToBuy / SECONDS_PER_BLOCK))
    const amount = BigInt(chainState.currentPrice) * blocks
    const totalChunks = 1n << BigInt(targetDepth)
    const totalPlur = amount * totalChunks

    return { amount: amount.toString(), bzzCost: plurToBzz(totalPlur.toString()) }
  })()

  const bzzBalance = wallet ? Number(plurToBzz(wallet.bzzBalance)) : null
  const canAfford = cost && bzzBalance !== null ? bzzBalance >= Number(cost.bzzCost) : true
  const canSubmit = (willDilute || totalSecondsToBuy > 0) && canAfford

  async function doExtend() {
    if (!canSubmit) return
    setExtendError(null)
    setSubmitting(true)
    try {
      // Topup BEFORE dilute. Diluting halves the per-chunk balance, so if it
      // would drop below the postage contract's minimum the on-chain tx emits
      // no BatchDepthIncrease event and Bee returns "cannot dilute batch".
      // Pre-topping avoids that.
      //
      // Per-chunk math: total BZZ cost is unchanged because Bee multiplies
      // amount × current-chunk-count. Diluting later halves the per-chunk
      // balance by 2^delta, so we scale the per-chunk amount up by 2^delta
      // here to land on the same final balance/chunk.
      if (cost) {
        const topupAmount =
          willDilute && depthDelta > 0 ? (BigInt(cost.amount) << BigInt(depthDelta)).toString() : cost.amount
        await beeApi.topupStamp(stamp.batchID, topupAmount)
      }

      if (willDilute) {
        await beeApi.diluteStamp(stamp.batchID, targetDepth)
      }
      queryClient.refetchQueries({ queryKey: ['bee', 'stamps'] })
      queryClient.refetchQueries({ queryKey: ['bee', 'wallet'] })
      onClose()
    } catch (err: any) {
      const raw = err?.message ?? 'Failed to extend drive.'
      // Bee errors come back as 'Bee API /…: 500 {"code":500,"message":"…"}'
      const inner = raw.match(/"message"\s*:\s*"([^"]+)"/)?.[1]
      const msg = raw.includes('402') ? 'Insufficient BZZ. Top up your wallet first.' : (inner ?? raw)
      setExtendError(msg)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div
      className="fixed inset-0 flex items-center justify-center z-50"
      style={{ backgroundColor: 'rgba(0,0,0,0.6)' }}
      onClick={() => {
        if (!submitting) onClose()
      }}
    >
      <div
        className="rounded-xl border p-6 w-96 space-y-5"
        style={{ backgroundColor: 'rgb(var(--bg-surface))' }}
        onClick={e => e.stopPropagation()}
      >
        <div>
          <p className="text-sm font-semibold">Extend drive</p>
          <p className="text-xs mt-1" style={{ color: 'rgb(var(--fg-muted))' }}>
            {stamp.label || `${stamp.batchID.slice(0, 20)}…`}
          </p>
          <p className="text-xs mt-0.5" style={{ color: 'rgb(var(--fg-muted))' }}>
            {depthToCapacity(stamp.depth)} · {Math.floor(stamp.batchTTL / 86400)} days remaining
          </p>
        </div>

        <div>
          <label className="flex items-center justify-between mb-2 cursor-pointer">
            <span className="text-xs uppercase tracking-widest" style={{ color: 'rgb(var(--fg-muted))' }}>
              Extend capacity
            </span>
            <Switch
              checked={capacityEnabled}
              onCheckedChange={setCapacityEnabled}
              disabled={capacityOptions.length === 0}
            />
          </label>
          {capacityEnabled && capacityOptions.length > 0 && (
            <div className="grid grid-cols-3 gap-2">
              {capacityOptions.map((s, i) => (
                <button
                  key={s.label}
                  onClick={() => setCapacityIdx(i)}
                  className="px-3 py-2 rounded-lg border text-sm transition-all"
                  style={{
                    borderColor: capacityIdx === i ? 'rgb(var(--accent))' : 'rgb(var(--border))',
                    backgroundColor: capacityIdx === i ? 'rgba(247,104,8,0.08)' : 'transparent',
                    color: capacityIdx === i ? 'rgb(var(--fg))' : 'rgb(var(--fg-muted))',
                  }}
                >
                  {s.label}
                </button>
              ))}
            </div>
          )}
          {capacityOptions.length === 0 && (
            <p className="text-[11px]" style={{ color: 'rgb(var(--fg-muted))' }}>
              Drive is already at the maximum size.
            </p>
          )}
        </div>

        <div>
          <label className="flex items-center justify-between mb-2 cursor-pointer">
            <span className="text-xs uppercase tracking-widest" style={{ color: 'rgb(var(--fg-muted))' }}>
              Extend duration
            </span>
            <Switch checked={durationEnabled} onCheckedChange={setDurationEnabled} />
          </label>
          {durationEnabled && (
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
          )}
        </div>

        {(willDilute || totalSecondsToBuy > 0) && (
          <div className="text-sm space-y-1">
            <p>
              <span style={{ color: 'rgb(var(--fg-muted))' }}>Cost: </span>
              <span className="font-semibold">{cost ? `${cost.bzzCost} BZZ` : 'Free'}</span>
              {cost && !canAfford && (
                <span className="ml-2 text-xs" style={{ color: '#ef4444' }}>
                  Insufficient BZZ
                </span>
              )}
            </p>
          </div>
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
            disabled={submitting || !canSubmit}
            className="flex-1 py-2 rounded-lg text-sm font-semibold disabled:opacity-40"
            style={{ backgroundColor: 'rgb(var(--accent))', color: 'rgb(var(--primary-foreground))' }}
          >
            {submitting ? 'Extending…' : 'Extend drive'}
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
      onClick={() => {
        if (phase !== 'updating') onClose()
      }}
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
                style={{ backgroundColor: 'rgb(var(--accent))', color: 'rgb(var(--primary-foreground))' }}
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
  const isEnc = record.isEncrypted && record.actPublisher && record.actHistoryRef

  // For encrypted files, build a proxy URL that includes ACT headers
  const actProxyUrl = isEnc
    ? `/act/download/${record.hash}?publisher=${record.actPublisher}&history=${record.actHistoryRef}`
    : null
  const openUrl = actProxyUrl ?? `${getBeeUrl()}/bzz/${linkHash}/`

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
        {record.isEncrypted ? (
          <Lock size={12} style={{ color: 'rgb(var(--accent))' }} />
        ) : record.type === 'file' && isImageFile(record.name) ? (
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
        {(record.type === 'folder' || record.type === 'website') && !isEnc ? (
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
        {!isEnc && (
          <button
            onClick={() => onCopy(record.id, linkHash)}
            title="Copy link"
            className="w-6 h-6 flex items-center justify-center rounded transition-colors"
            style={{ color: copiedId === record.id ? '#4ade80' : 'rgb(var(--fg-muted))' }}
          >
            <Copy size={12} />
          </button>
        )}
        {!isEnc && (
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
        )}
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
  /** Creator's Nook address when this encrypted drive was made with a DIFFERENT
   *  identity than the one currently connected — undefined when openable. */
  lockedForCreator?: string
  onOpen: (folderId?: string) => void
  onExtend: () => void
  onShare?: () => void
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
  lockedForCreator,
  onShare,
  onMoveToFolder,
}: DriveCardProps) {
  const [inlineDraggingId, setInlineDraggingId] = useState<string | null>(null)
  const [inlineDragOverFolderId, setInlineDragOverFolderId] = useState<string | null>(null)
  const [renaming, setRenaming] = useState(false)
  const [renameInput, setRenameInput] = useState('')
  const [kebabOpen, setKebabOpen] = useState(false)
  const kebabRef = useRef<HTMLDivElement>(null)
  const MAX_TTL = 365 * 24 * 3600
  const ttlPct = Math.min((stamp.batchTTL / MAX_TTL) * 100, 100)
  const color = ttlColor(stamp.batchTTL)
  const hasName = Boolean(customName || stamp.label)
  const driveName = customName || stamp.label || `${stamp.batchID.slice(0, 8)}…`
  const capacityBytes = depthToBytes(stamp.depth)
  const maxUtilization = 1 << (stamp.depth - stamp.bucketDepth)
  // Use Bee's reported utilization (matches swarm-cli) instead of summing local
  // upload history — anything uploaded outside Nook (swarm-cli, ACT chunks,
  // feed updates) wouldn't show up otherwise. Bee's metric is worst-case
  // bucket-fill, so the byte estimate is conservative.
  const usedBytes = maxUtilization > 0 ? Math.round(capacityBytes * (stamp.utilization / maxUtilization)) : 0
  const usagePct = capacityBytes > 0 ? Math.min((usedBytes / capacityBytes) * 100, 100) : 0
  const utilizationPct = Math.round((stamp.utilization / maxUtilization) * 100)
  const isFull = stamp.utilization >= maxUtilization
  const ttlDays = stamp.batchTTL / 86400
  // Critical = days-pill turns red. Matches Figma's 'red at ≤7 days' threshold.
  const isCriticalTtl = stamp.usable && ttlDays > 0 && ttlDays <= 7
  // Extend button surfaces earlier so users have time to act before things go red.
  const needsExtend = stamp.usable && ((ttlDays > 0 && ttlDays <= 30) || isFull)
  const hasWebsite = records.some(r => r.type === 'website')

  // Close kebab on outside click
  useEffect(() => {
    if (!kebabOpen) return
    const handler = (e: MouseEvent) => {
      if (kebabRef.current && !kebabRef.current.contains(e.target as Node)) setKebabOpen(false)
    }
    document.addEventListener('mousedown', handler)

    return () => document.removeEventListener('mousedown', handler)
  }, [kebabOpen])
  const rootFolders = folders.filter(f => !f.parentFolderId)
  const rootFiles = records.filter(r => !r.folderId)
  const itemSummary = (() => {
    const parts = []

    if (rootFolders.length > 0) parts.push(`${rootFolders.length} folder${rootFolders.length !== 1 ? 's' : ''}`)

    if (rootFiles.length > 0) parts.push(`${rootFiles.length} file${rootFiles.length !== 1 ? 's' : ''}`)

    return parts.join(', ') || '0 files'
  })()

  function renderInlineFolder(folder: DriveFolder, depth: number): React.ReactElement {
    return (
      <div key={folder.id} style={{ paddingLeft: `${depth * 12}px` }}>
        <div
          onClick={() => onOpen(folder.id)}
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
          <FolderOpen size={11} style={{ color: 'rgb(var(--fg-muted))' }} />
          <span className="text-xs flex-1 truncate">{folder.name}</span>
        </div>
      </div>
    )
  }

  return (
    <div className="border-b" style={{ borderColor: 'rgb(var(--border))' }}>
      <div
        className="px-4 py-3 hover:bg-[rgb(var(--bg-surface))] transition-colors cursor-pointer"
        onClick={() => onOpen()}
      >
        {/* Top line: name + pills + actions */}
        <div className="flex items-center gap-2">
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
              className="text-lg font-medium bg-transparent border-b outline-none flex-1 min-w-0"
              style={{ borderColor: 'rgb(var(--accent))', color: 'rgb(var(--fg))' }}
            />
          ) : !hasName ? (
            <button
              onClick={e => {
                e.stopPropagation()
                setRenameInput('')
                setRenaming(true)
              }}
              className="text-lg font-medium text-left min-w-0 truncate"
              style={{ color: 'rgb(var(--fg-muted))', fontStyle: 'italic' }}
            >
              Name this drive…
            </button>
          ) : (
            <span className="text-lg font-medium truncate min-w-0">{driveName}</span>
          )}

          {/* Encrypted pill */}
          {encrypted && (
            <span
              className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full font-semibold shrink-0"
              style={{ backgroundColor: '#3b82f6', color: 'white' }}
            >
              <Lock size={12} />
              Encrypted{granteeCount && granteeCount > 1 ? ` · ${granteeCount - 1} shared` : ''}
            </span>
          )}

          {/* Locked for a different identity — this drive's encrypted metadata was
              created with another wallet, so the current identity can't open it. */}
          {lockedForCreator && (
            <span
              className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full font-semibold shrink-0"
              style={{ backgroundColor: 'rgba(247,104,8,0.12)', color: 'rgb(var(--accent))' }}
              title={`Created with a different Nook identity (${lockedForCreator}). Connect that wallet to open this drive.`}
            >
              <Lock size={12} />
              Connect {`${lockedForCreator.slice(0, 6)}…${lockedForCreator.slice(-4)}`} to open
            </span>
          )}

          {/* Confirming pill */}
          {!stamp.usable && (
            <span
              className="text-[10px] px-2 py-0.5 rounded-full font-semibold uppercase tracking-widest animate-pulse shrink-0"
              style={{ backgroundColor: 'rgba(247,104,8,0.1)', color: 'rgb(var(--accent))' }}
            >
              Confirming…
            </span>
          )}

          {/* Website pill */}
          {hasWebsite && (
            <span
              className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full font-medium shrink-0"
              style={{ backgroundColor: 'rgba(74,222,128,0.1)', color: '#4ade80' }}
            >
              <Globe size={11} />
              Website
            </span>
          )}

          {/* Right-side actions */}
          <div className="ml-auto flex items-center gap-2 shrink-0">
            {needsExtend && (
              <button
                onClick={e => {
                  e.stopPropagation()
                  onExtend()
                }}
                className="px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors border hover:bg-white/[0.04]"
                style={{ borderColor: 'rgb(var(--border))', color: 'rgb(var(--fg))' }}
              >
                Extend storage
              </button>
            )}

            <div ref={kebabRef} className="relative">
              <button
                onClick={e => {
                  e.stopPropagation()
                  setKebabOpen(v => !v)
                }}
                aria-label="Drive actions"
                className="w-7 h-7 flex items-center justify-center rounded hover:bg-white/10 transition-colors"
                style={{ color: 'rgb(var(--fg-muted))' }}
              >
                <MoreVertical size={16} />
              </button>
              {kebabOpen && (
                <div
                  className="absolute right-0 top-full mt-1 rounded-lg border py-1 z-40 w-44"
                  style={{ backgroundColor: 'rgb(var(--bg-surface))', borderColor: 'rgb(var(--border))' }}
                  onClick={e => e.stopPropagation()}
                >
                  <button
                    onClick={() => {
                      setKebabOpen(false)
                      onExtend()
                    }}
                    disabled={!stamp.usable}
                    className="flex items-center gap-2 w-full px-3 py-2 text-xs transition-colors hover:bg-white/5 disabled:opacity-40 disabled:cursor-not-allowed"
                    style={{ color: 'rgb(var(--fg))' }}
                  >
                    <Clock size={13} style={{ color: 'rgb(var(--fg-muted))' }} />
                    Extend storage
                  </button>
                  {encrypted && onShare && (
                    <button
                      onClick={() => {
                        setKebabOpen(false)
                        onShare()
                      }}
                      className="flex items-center gap-2 w-full px-3 py-2 text-xs transition-colors hover:bg-white/5"
                      style={{ color: 'rgb(var(--fg))' }}
                    >
                      <Share2 size={13} style={{ color: 'rgb(var(--fg-muted))' }} />
                      Share…
                    </button>
                  )}
                  <button
                    onClick={() => {
                      setKebabOpen(false)
                      setRenameInput(hasName ? driveName : '')
                      setRenaming(true)
                    }}
                    className="flex items-center gap-2 w-full px-3 py-2 text-xs transition-colors hover:bg-white/5"
                    style={{ color: 'rgb(var(--fg))' }}
                  >
                    <Pencil size={13} style={{ color: 'rgb(var(--fg-muted))' }} />
                    Rename
                  </button>
                  <button
                    disabled
                    title="Coming soon"
                    className="flex items-center gap-2 w-full px-3 py-2 text-xs opacity-40 cursor-not-allowed"
                    style={{ color: 'rgb(var(--fg))' }}
                  >
                    <X size={13} style={{ color: 'rgb(var(--fg-muted))' }} />
                    Forget
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Bottom line: utilization bar + size + days-left pill + items */}
        <div className="flex items-center gap-2 mt-2 text-sm">
          <div
            className="w-32 h-1 rounded-full shrink-0"
            style={{ backgroundColor: 'rgb(var(--border))' }}
            aria-label={`${Math.round(usagePct)}% used`}
          >
            <div
              className="h-1 rounded-full"
              style={{
                width: `${usagePct}%`,
                backgroundColor: isFull ? '#ef4444' : 'rgb(var(--fg))',
              }}
            />
          </div>
          <span style={{ color: isFull ? '#ef4444' : 'rgb(var(--fg-muted))' }}>
            {usedBytes > 0 ? `${formatBytes(usedBytes)} / ${formatBytes(capacityBytes)}` : formatBytes(capacityBytes)}
          </span>
          {stamp.usable && (
            <span
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full"
              style={
                isCriticalTtl
                  ? { backgroundColor: 'rgba(239,68,68,0.1)', color: '#ef4444' }
                  : { backgroundColor: 'rgba(255,255,255,0.05)', color: 'rgb(var(--fg-muted))' }
              }
            >
              <Clock size={11} />
              {ttlToDays(stamp.batchTTL)}
            </span>
          )}
          <span style={{ color: 'rgb(var(--border))' }}>|</span>
          <span style={{ color: 'rgb(var(--fg-muted))' }}>{itemSummary}</span>
        </div>
      </div>
    </div>
  )
}

// ─── Inline upload panel ───────────────────────────────────────────────────────

type UploadType = 'file' | 'folder'

interface AddFileProps {
  driveId: string
  encrypted?: boolean
  actHistoryRef?: string
  onDone: () => void
  onAdd: (record: UploadRecord) => void
  onActHistoryUpdate?: (historyRef: string) => void
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

function AddFilePanel({ driveId, encrypted, actHistoryRef, onDone, onAdd, onActHistoryUpdate }: AddFileProps) {
  const { data: addresses } = useAddresses()
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

      let currentHistoryRef = actHistoryRef

      async function doUpload(attempt: number): Promise<{ reference: string; historyAddress?: string }> {
        if (attempt > 1) {
          setPhase(`Finalising storage… (retry ${attempt - 1})`)
          await new Promise(r => setTimeout(r, 5000))
        }
        setPhase(encrypted ? 'Encrypting & uploading…' : 'Uploading…')
        setProgress(0)

        if (encrypted) {
          if (type === 'file') {
            return beeApi.uploadFileWithACT(entries[0].file, driveId, currentHistoryRef, pct => setProgress(pct))
          }

          return beeApi.uploadCollectionWithACT(uploadEntries, driveId, currentHistoryRef, { indexDocument }, pct =>
            setProgress(pct),
          )
        }

        if (type === 'file') {
          const res = await beeApi.uploadFileWithProgress(entries[0].file, driveId, pct => setProgress(pct))

          return { reference: res.reference }
        }

        const res = await beeApi.uploadCollectionWithProgress(uploadEntries, driveId, { indexDocument }, pct =>
          setProgress(pct),
        )

        return { reference: res.reference }
      }

      let reference!: string
      let uploadHistoryAddress: string | undefined

      for (let attempt = 1; attempt <= 4; attempt++) {
        try {
          const result = await doUpload(attempt)
          reference = result.reference
          uploadHistoryAddress = result.historyAddress

          if (uploadHistoryAddress) {
            currentHistoryRef = uploadHistoryAddress
            onActHistoryUpdate?.(uploadHistoryAddress)
          }
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

      const newRecord: UploadRecord = {
        id: crypto.randomUUID(),
        name,
        hash: reference,
        size: entries.reduce((sum, e) => sum + e.file.size, 0),
        type,
        driveId,
        expiresAt,
        uploadedAt: Date.now(),
        hasFeed: false,
        isEncrypted: encrypted || undefined,
        actPublisher: encrypted ? addresses?.publicKey : undefined,
        actHistoryRef: uploadHistoryAddress || undefined,
      }

      onAdd(newRecord)

      // Update metadata feed for encrypted drives (enables live shared drive access)
      if (encrypted && addresses?.publicKey && uploadHistoryAddress) {
        try {
          const topic = await topicFromString(driveId + 'nook-drive-meta')
          // Build file list from localStorage + explicitly include the just-uploaded file
          // (localStorage write from onAdd may be batched by React)
          const existingRecords = JSON.parse(localStorage.getItem('swarm-drive') ?? '[]') as UploadRecord[]
          const existingFiles = existingRecords
            .filter((r: UploadRecord) => r.driveId === driveId && r.actHistoryRef && r.id !== newRecord.id)
            .map((r: UploadRecord) => ({
              name: r.name,
              reference: r.hash,
              historyRef: r.actHistoryRef,
              size: r.size,
            }))

          // Always include the just-uploaded file
          const driveFiles = [
            ...existingFiles,
            { name: newRecord.name, reference: newRecord.hash, historyRef: uploadHistoryAddress, size: newRecord.size },
          ]

          const metadata = JSON.stringify({ files: driveFiles })
          // Use the drive's latest ACT history (includes grantee additions), not just file upload history
          const latestHistory = actHistoryRef || uploadHistoryAddress
          const uploaded = await serverApi.uploadACTMetadata(driveId, metadata, latestHistory)

          // Upload wrapper as raw bytes (not /bzz file) so feed reader can use /bytes
          const wrapper = JSON.stringify({ ref: uploaded.reference, history: uploaded.historyRef })
          const wrapperResult = await serverApi.uploadRawBytes(driveId, wrapper)

          await serverApi.createFeedUpdate(topic, wrapperResult.reference, driveId)
          onActHistoryUpdate?.(uploaded.historyRef)
        } catch {
          // Feed update failed — not critical, drive still works without live sharing
        }
      }

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

// ─── SharedDriveCard ──────────────────────────────────────────────────────────

function SharedDriveCard({
  drive,
  onRemove,
  onRefresh,
}: {
  drive: import('../hooks/useSharedDrives').SharedDrive
  onRemove: () => void
  onRefresh?: () => void
}) {
  const [expanded, setExpanded] = useState(false)
  const [editingName, setEditingName] = useState(false)
  const [nameInput, setNameInput] = useState('')
  const [editingFrom, setEditingFrom] = useState(false)
  const [fromInput, setFromInput] = useState('')
  const [refreshing, setRefreshing] = useState(false)

  // Auto-sync every 5 minutes for feed-based shared drives
  useEffect(() => {
    if (!drive.feedTopic || !drive.feedOwner || !onRefresh) return

    const interval = setInterval(
      () => {
        handleRefresh()
      },
      5 * 60 * 1000,
    )

    return () => clearInterval(interval)
  }, [drive.feedTopic, drive.feedOwner])

  async function handleRefresh() {
    if (!drive.feedTopic || !drive.feedOwner || !onRefresh) return
    setRefreshing(true)
    try {
      const wrapperText = await serverApi.readFeed(drive.feedTopic, drive.feedOwner)
      const wrapper = JSON.parse(wrapperText) as { ref: string; history: string }
      const blob = await beeApi.downloadFileWithACT(wrapper.ref, drive.actPublisher, wrapper.history)
      const metadata = JSON.parse(await blob.text())

      // Update localStorage with new files
      const drives: import('../hooks/useSharedDrives').SharedDrive[] = JSON.parse(
        localStorage.getItem('nook-shared-drives') ?? '[]',
      )
      const updated = drives.map(d =>
        d.id === drive.id ? { ...d, files: metadata.files, actHistoryRef: wrapper.history } : d,
      )
      localStorage.setItem('nook-shared-drives', JSON.stringify(updated))
      onRefresh()
    } catch {
      // eslint-disable-next-line no-alert
      alert('Could not refresh. Access may have been revoked.')
    } finally {
      setRefreshing(false)
    }
  }

  // Look up label for the publisher key from grantee labels
  const granteeLabels: Record<string, string> = (() => {
    try {
      return JSON.parse(localStorage.getItem('nook-grantee-labels') ?? '{}')
    } catch {
      return {}
    }
  })()

  function findPublisherLabel(): string | undefined {
    const pubClean = drive.actPublisher.toLowerCase().replace('0x', '')

    for (const [key, label] of Object.entries(granteeLabels)) {
      const keyClean = key.toLowerCase().replace('0x', '')

      // D10: exact match only. The previous bidirectional `includes()` meant an
      // empty-string key matched every publisher, and any key that was a hex
      // substring of the publisher (or vice-versa) produced a false label.
      if (keyClean.length > 0 && keyClean === pubClean) return label
    }

    return undefined
  }

  const publisherLabel = drive.fromLabel ?? findPublisherLabel()

  function saveToLocalStorage(partial: Record<string, string>) {
    const drives: import('../hooks/useSharedDrives').SharedDrive[] = JSON.parse(
      localStorage.getItem('nook-shared-drives') ?? '[]',
    )
    const updated = drives.map(d => (d.id === drive.id ? { ...d, ...partial } : d))
    localStorage.setItem('nook-shared-drives', JSON.stringify(updated))
  }

  async function downloadFile(ref: string, _fileHistoryRef: string, fileName: string) {
    try {
      // Use the drive's latest ACT history ref (from share link), not the file's individual history.
      // The drive history includes all grantees added after file upload.
      const blob = await beeApi.downloadFileWithACT(ref, drive.actPublisher, drive.actHistoryRef)
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = fileName
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
    } catch {
      // eslint-disable-next-line no-alert
      alert('Access revoked or content unavailable.')
    }
  }

  return (
    <div className="border-b" style={{ borderColor: 'rgb(var(--border))' }}>
      <div
        className="flex items-center gap-3 px-4 py-3 hover:bg-[rgb(var(--bg-surface))] transition-colors cursor-pointer"
        onClick={() => drive.files?.length && setExpanded(v => !v)}
      >
        {drive.files?.length ? (
          <span style={{ color: 'rgb(var(--fg-muted))' }}>
            {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          </span>
        ) : (
          <span className="w-[13px]" />
        )}
        <Users size={14} className="shrink-0" style={{ color: 'rgb(var(--accent))' }} />

        {/* Drive name — editable */}
        {editingName ? (
          <input
            autoFocus
            value={nameInput}
            onChange={e => setNameInput(e.target.value)}
            onBlur={() => {
              if (nameInput.trim()) saveToLocalStorage({ name: nameInput.trim() })
              setEditingName(false)
            }}
            onKeyDown={e => {
              if (e.key === 'Enter' && nameInput.trim()) {
                saveToLocalStorage({ name: nameInput.trim() })
                setEditingName(false)
              }

              if (e.key === 'Escape') setEditingName(false)
            }}
            onClick={e => e.stopPropagation()}
            className="text-sm font-medium bg-transparent border-b outline-none flex-1 min-w-0"
            style={{ borderColor: 'rgb(var(--accent))', color: 'rgb(var(--fg))' }}
          />
        ) : (
          <span className="text-sm font-medium truncate flex-1 group/name flex items-center gap-1 min-w-0">
            <span className="truncate">{drive.name}</span>
            <button
              onClick={e => {
                e.stopPropagation()
                setNameInput(drive.name)
                setEditingName(true)
              }}
              className="opacity-0 group-hover/name:opacity-100 transition-opacity shrink-0"
              style={{ color: 'rgb(var(--fg-muted))' }}
            >
              <Pencil size={10} />
            </button>
          </span>
        )}

        <span className="text-xs shrink-0" style={{ color: 'rgb(var(--fg-muted))' }}>
          {drive.files?.length ? `${drive.files.length} file${drive.files.length !== 1 ? 's' : ''}` : ''}
        </span>

        {/* From label — editable */}
        {editingFrom ? (
          <input
            autoFocus
            value={fromInput}
            onChange={e => setFromInput(e.target.value)}
            onBlur={() => {
              if (fromInput.trim()) saveToLocalStorage({ fromLabel: fromInput.trim() })
              setEditingFrom(false)
            }}
            onKeyDown={e => {
              if (e.key === 'Enter' && fromInput.trim()) {
                saveToLocalStorage({ fromLabel: fromInput.trim() })
                setEditingFrom(false)
              }

              if (e.key === 'Escape') setEditingFrom(false)
            }}
            onClick={e => e.stopPropagation()}
            className="text-xs bg-transparent border-b outline-none w-24"
            style={{ borderColor: 'rgb(var(--accent))', color: 'rgb(var(--fg))' }}
            placeholder="Name"
          />
        ) : (
          <span
            className="text-xs shrink-0 group/from flex items-center gap-1"
            style={{ color: 'rgb(var(--fg-muted))' }}
          >
            from {publisherLabel ?? `${drive.actPublisher.slice(0, 8)}…`}
            <button
              onClick={e => {
                e.stopPropagation()
                setFromInput(publisherLabel ?? '')
                setEditingFrom(true)
              }}
              className="opacity-0 group-hover/from:opacity-100 transition-opacity"
              style={{ color: 'rgb(var(--fg-muted))' }}
            >
              <Pencil size={9} />
            </button>
          </span>
        )}
        {drive.feedTopic && (
          <button
            onClick={async e => {
              e.stopPropagation()
              await handleRefresh()
            }}
            disabled={refreshing}
            className="shrink-0 w-6 h-6 flex items-center justify-center rounded transition-colors disabled:opacity-40"
            style={{ color: 'rgb(var(--accent))' }}
            title="Sync"
          >
            <RefreshCw size={12} className={refreshing ? 'animate-spin' : ''} />
          </button>
        )}
        <button
          onClick={e => {
            e.stopPropagation()
            onRemove()
          }}
          className="shrink-0 w-6 h-6 flex items-center justify-center rounded transition-colors hover:text-red-400"
          style={{ color: 'rgb(var(--fg-muted))' }}
          title="Remove from list"
        >
          <Trash2 size={12} />
        </button>
      </div>

      {expanded && drive.files && (
        <div className="border-t py-2 px-6" style={{ borderColor: 'rgb(var(--border))' }}>
          {drive.files.map(file => (
            <div key={file.reference} className="flex items-center gap-3 px-2 py-2">
              <Lock size={12} style={{ color: 'rgb(var(--accent))' }} />
              <span className="text-xs font-medium flex-1 truncate">{file.name}</span>
              <span className="text-xs shrink-0" style={{ color: 'rgb(var(--fg-muted))' }}>
                {formatBytes(file.size)}
              </span>
              <button
                onClick={async () => downloadFile(file.reference, file.historyRef, file.name)}
                className="shrink-0 w-6 h-6 flex items-center justify-center rounded transition-colors"
                style={{ color: 'rgb(var(--fg-muted))' }}
                title="Download"
              >
                <Download size={12} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export default function Drive() {
  const { toggle: toggleSidebar } = useSidebar()
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
  const { data: nodeAddresses } = useAddresses()
  const { gatewayUrl } = useAppStore()
  const location = useLocation()
  const driveMetadata = useDriveMetadata()
  const sharedDrives = useSharedDrives()
  const { signer } = useDerivedKey()

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
  const [showShareModal, setShowShareModal] = useState<string | null>(null) // batchID
  const [showAddSharedModal, setShowAddSharedModal] = useState(false)
  const [driveTab, setDriveTab] = useState<'mine' | 'shared'>('mine')
  const [addingFile, setAddingFile] = useState(false)
  const [search, setSearch] = useState('')
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const [downloadingId, setDownloadingId] = useState<string | null>(null)
  const [downloadPct, setDownloadPct] = useState<number | null>(null)
  const [updatingId, setUpdatingId] = useState<string | null>(null)
  const [ensRecordId, setEnsRecordId] = useState<string | null>(null)

  // Folder UI state
  const [openFolderId, setOpenFolderId] = useState<string | null>(null)
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
      // Check if file is encrypted — find the record and its drive metadata
      const record = records.find(r => r.id === id)
      const actOptions =
        record?.isEncrypted && record?.actPublisher && record?.actHistoryRef
          ? { actPublisher: record.actPublisher, actHistoryRef: record.actHistoryRef }
          : undefined

      await downloadFromSwarm(hash, name, pct => setDownloadPct(pct), actOptions)
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
        <div className="flex items-center gap-3 mb-4">
          <button
            onClick={toggleSidebar}
            aria-label="Toggle sidebar"
            className="w-8 h-8 flex items-center justify-center rounded-lg transition-colors hover:bg-white/[0.04] shrink-0"
            style={{ color: 'rgb(var(--fg-muted))' }}
          >
            <PanelLeft size={16} />
          </button>

          <Tabs value={driveTab} onValueChange={v => setDriveTab(v as 'mine' | 'shared')}>
            <TabsList>
              <TabsTrigger value="mine">My drives{allStamps.length > 0 ? ` (${allStamps.length})` : ''}</TabsTrigger>
              <TabsTrigger value="shared">
                Shared with me{sharedDrives.drives.length > 0 ? ` (${sharedDrives.drives.length})` : ''}
              </TabsTrigger>
            </TabsList>
          </Tabs>

          <div className="flex-1" />

          <div className="relative w-[280px] shrink-0">
            <Search
              size={12}
              className="absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none"
              style={{ color: 'rgb(var(--fg-muted))' }}
            />
            <input
              type="text"
              placeholder="Search all files…"
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="w-full pl-7 pr-3 py-1.5 rounded-lg border text-xs focus:outline-none"
              style={{
                backgroundColor: 'rgb(var(--bg-surface))',
                color: 'rgb(var(--fg))',
                borderColor: 'rgb(var(--border))',
              }}
            />
          </div>

          {driveTab === 'mine' ? (
            <button
              onClick={() => setShowBuyModal(true)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold shrink-0 mr-[52px]"
              style={{ backgroundColor: 'rgb(var(--accent))', color: 'rgb(var(--primary-foreground))' }}
            >
              <Plus size={12} />
              New drive
            </button>
          ) : (
            <button
              onClick={() => setShowAddSharedModal(true)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold shrink-0 mr-[52px]"
              style={{ backgroundColor: 'rgb(var(--accent))', color: 'rgb(var(--primary-foreground))' }}
            >
              <Plus size={12} />
              Add shared drive
            </button>
          )}
        </div>

        {/* Content */}
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
        ) : driveTab === 'shared' ? (
          /* Shared drives tab */
          sharedDrives.drives.length === 0 ? (
            <p className="text-xs text-center py-8" style={{ color: 'rgb(var(--fg-muted))' }}>
              No shared drives yet. When someone shares a drive with you, paste the share link here.
            </p>
          ) : (
            <div className="border-t" style={{ borderColor: 'rgb(var(--border))' }}>
              {sharedDrives.drives.map(drive => (
                <SharedDriveCard
                  key={drive.id}
                  drive={drive}
                  onRemove={() => sharedDrives.remove(drive.id)}
                  onRefresh={() => sharedDrives.reload()}
                />
              ))}
            </div>
          )
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
              style={{ backgroundColor: 'rgb(var(--accent))', color: 'rgb(var(--primary-foreground))' }}
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
                lockedForCreator={(() => {
                  const cw = driveMetadata.get(stamp.batchID)?.creatorWpub
                  const me = signer?.getAddress()

                  // Only flag when we KNOW the creator and it differs from the
                  // connected identity (older drives without creatorWpub are left alone).
                  return cw && me && cw.toLowerCase() !== me.toLowerCase() ? cw : undefined
                })()}
                onOpen={folderId => {
                  setActiveDriveId(stamp.batchID)

                  if (folderId) setOpenFolderId(folderId)
                }}
                onShare={() => setShowShareModal(stamp.batchID)}
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

        {showAddSharedModal && (
          <AddSharedDriveModal
            myPublicKey={nodeAddresses?.publicKey}
            onClose={() => setShowAddSharedModal(false)}
            onAdd={drive => sharedDrives.add(drive)}
          />
        )}

        {showBuyModal && (
          <BuyDriveModal
            onClose={() => setShowBuyModal(false)}
            onCreated={(batchId, encrypted) => {
              if (encrypted) {
                driveMetadata.set(batchId, {
                  encrypted: true,
                  creatorWpub: signer?.getAddress() ?? undefined,
                })
              }
            }}
          />
        )}
        {extendingStamp && <ExtendModal stamp={extendingStamp} onClose={() => setShowExtendModal(null)} />}
        {showShareModal &&
          (() => {
            const meta = driveMetadata.get(showShareModal)
            const stamp = allStamps.find(s => s.batchID === showShareModal)
            const driveRecordsForShare = records.filter(r => r.driveId === showShareModal)
            const firstRef = driveRecordsForShare.find(r => r.actHistoryRef)

            return (
              <ShareModal
                driveName={stamp?.label || customDriveLabels[showShareModal] || 'Encrypted drive'}
                stampId={showShareModal}
                actPublisher={meta?.actPublisher || firstRef?.actPublisher}
                actHistoryRef={meta?.actHistoryRef || firstRef?.actHistoryRef}
                granteeRef={meta?.granteeRef}
                myPublicKey={nodeAddresses?.publicKey}
                beeAddress={nodeAddresses?.ethereum}
                files={driveRecordsForShare
                  .filter(r => r.actHistoryRef && r.actPublisher)
                  .map(r => ({ name: r.name, reference: r.hash, historyRef: r.actHistoryRef!, size: r.size }))}
                onClose={() => setShowShareModal(null)}
                onUpdate={({ granteeRef, historyRef, granteeCount }) => {
                  driveMetadata.update(showShareModal, { granteeRef, actHistoryRef: historyRef, granteeCount })
                }}
              />
            )
          })()}
        {updatingRecord && <UpdateFeedModal record={updatingRecord} onClose={() => setUpdatingId(null)} />}
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

  function renderFolder(folder: DriveFolder, depth: number): React.ReactElement {
    const isOver = dragOverId === folder.id
    const childFolders = folders.filter(f => f.parentFolderId === folder.id)
    const folderRecords = driveRecords.filter(r => r.folderId === folder.id)
    const count = folderRecords.length + childFolders.length
    const py = depth === 0 ? 'py-2.5' : 'py-2'

    return (
      <div key={folder.id}>
        <div
          onClick={() => {
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
            style={{ backgroundColor: 'rgb(var(--accent))', color: 'rgb(var(--primary-foreground))' }}
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
            style={{ backgroundColor: 'rgb(var(--accent))', color: 'rgb(var(--primary-foreground))' }}
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
          {driveMetadata.isEncrypted(activeDriveId) && (
            <button
              onClick={() => setShowShareModal(activeDriveId)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs font-medium shrink-0"
              style={{ color: 'rgb(var(--accent))' }}
            >
              <Lock size={12} />
              Share
            </button>
          )}
        </div>
      )}

      {/* Inline upload panel */}
      {addingFile && (
        <AddFilePanel
          driveId={activeDriveId}
          encrypted={driveMetadata.isEncrypted(activeDriveId)}
          actHistoryRef={driveMetadata.get(activeDriveId)?.actHistoryRef}
          onDone={() => setAddingFile(false)}
          onAdd={record => {
            addRecord({ ...record, folderId: openFolderId ?? undefined })
          }}
          onActHistoryUpdate={historyRef => {
            driveMetadata.update(activeDriveId, { actHistoryRef: historyRef })
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
        <div className="space-y-1 mb-3">{visibleFolders.map(folder => renderFolder(folder, 0))}</div>
      )}

      {/* Move to root drop zone — always rendered to avoid DOM insertion during drag */}
      <div
        onDragOver={
          draggingId
            ? e => {
                e.preventDefault()
                setDragOverId('root')
              }
            : undefined
        }
        onDragLeave={
          draggingId
            ? e => {
                if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOverId(null)
              }
            : undefined
        }
        onDrop={
          draggingId
            ? e => {
                e.preventDefault()
                const recordId = e.dataTransfer.getData('recordId')

                if (recordId) moveToFolder(recordId, null)
                setDraggingId(null)
                setDragOverId(null)
              }
            : undefined
        }
        className={`rounded-lg border-2 border-dashed text-center text-xs transition-all ${
          draggingId ? 'px-4 py-3 mb-3 opacity-100' : 'h-0 overflow-hidden opacity-0 border-transparent'
        }`}
        style={
          draggingId
            ? {
                borderColor: dragOverId === 'root' ? 'rgb(var(--accent))' : 'rgb(var(--border))',
                color: dragOverId === 'root' ? 'rgb(var(--accent))' : 'rgb(var(--fg-muted))',
                backgroundColor: dragOverId === 'root' ? 'rgba(247,104,8,0.05)' : 'transparent',
              }
            : undefined
        }
      >
        Drop here to move out of folder
      </div>

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
      {showShareModal &&
        (() => {
          const meta = driveMetadata.get(showShareModal)
          const stamp = allStamps.find(s => s.batchID === showShareModal)
          const driveRecordsForShare = records.filter(r => r.driveId === showShareModal)
          const firstRef = driveRecordsForShare.find(r => r.actHistoryRef)

          return (
            <ShareModal
              driveName={stamp?.label || customDriveLabels[showShareModal] || 'Encrypted drive'}
              stampId={showShareModal}
              actPublisher={meta?.actPublisher || firstRef?.actPublisher}
              actHistoryRef={meta?.actHistoryRef || firstRef?.actHistoryRef}
              granteeRef={meta?.granteeRef}
              myPublicKey={nodeAddresses?.publicKey}
              beeAddress={nodeAddresses?.ethereum}
              files={driveRecordsForShare
                .filter(r => r.actHistoryRef && r.actPublisher)
                .map(r => ({ name: r.name, reference: r.hash, historyRef: r.actHistoryRef!, size: r.size }))}
              onClose={() => setShowShareModal(null)}
              onUpdate={({ granteeRef, historyRef, granteeCount }) => {
                driveMetadata.update(showShareModal, { granteeRef, actHistoryRef: historyRef, granteeCount })
              }}
            />
          )
        })()}
    </div>
  )
}
