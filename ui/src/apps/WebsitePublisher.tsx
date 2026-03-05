import { Check, ChevronRight, Copy, ExternalLink, Globe, RefreshCw, Upload } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import {
  calcStampCost,
  depthToBytes,
  DURATION_PRESETS,
  getBeeUrl,
  plurToBzz,
  SIZE_PRESETS,
} from '../api/bee'
import {
  useBeeHealth,
  useBuyStamp,
  useChainState,
  useWallet,
} from '../api/queries'
import { useAppStore } from '../store/app'
import { useUpload } from '../hooks/useUpload'
import {
  detectIndexDocument,
  fileListToEntries,
  readDroppedDirectory,
  totalSize,
  type FileEntry,
} from '../utils/directory'

// ─── Types ────────────────────────────────────────────────────────────────────

type Step = 'select' | 'options' | 'publishing' | 'done'

interface SelectedContent {
  name: string
  entries: FileEntry[]
  size: number
  indexDocument: string
}

interface PublishResult {
  hash: string
  expiresAt: number
  feedManifestAddress?: string
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatBytes(bytes: number): string {
  if (bytes >= 1_073_741_824) return `${(bytes / 1_073_741_824).toFixed(1)} GB`
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)} MB`
  return `${(bytes / 1024).toFixed(0)} KB`
}

function PlanButton({ label, selected, onClick }: { label: string; selected: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="px-4 py-2.5 rounded-lg border text-sm font-medium transition-all"
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

// ─── Main component ───────────────────────────────────────────────────────────

export default function WebsitePublisher() {
  const [step, setStep] = useState<Step>('select')
  const [content, setContent] = useState<SelectedContent | null>(null)
  const [dragging, setDragging] = useState(false)

  // Options state
  const [sizeIdx, setSizeIdx] = useState(1)
  const [durationIdx, setDurationIdx] = useState(1)
  const [driveName, setDriveName] = useState('')
  const [feedEnabled, setFeedEnabled] = useState(false)
  const [feedTopic, setFeedTopic] = useState('')

  // Publishing state
  const [publishPhase, setPublishPhase] = useState('')
  const [publishError, setPublishError] = useState<string | null>(null)
  const [uploadProgress, setUploadProgress] = useState<number | null>(null)

  // Done state
  const [result, setResult] = useState<PublishResult | null>(null)
  const [copied, setCopied] = useState(false)

  const dirInputRef = useRef<HTMLInputElement>(null)
  const navigate = useNavigate()
  const location = useLocation()

  // Reset when sidebar item is clicked (new location.key)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { reset() }, [location.key])

  const { isError: beeOffline, isSuccess: beeOnline } = useBeeHealth()
  const { data: chainState } = useChainState()
  const { data: wallet } = useWallet()
  const { gatewayUrl } = useAppStore()
  const buyStamp = useBuyStamp()
  const { upload } = useUpload()

const selectedSize = SIZE_PRESETS[sizeIdx]
  const selectedDuration = DURATION_PRESETS[durationIdx]
  const cost = chainState ? calcStampCost(selectedSize.depth, selectedDuration.months, chainState.currentPrice) : null
  const bzzBalance = wallet ? Number(plurToBzz(wallet.bzzBalance)) : null
  const canAfford = cost && bzzBalance !== null ? bzzBalance >= Number(cost.bzzCost) : true

  // ── Content selection ─────────────────────────────────────────────────────

  function acceptContent(c: SelectedContent) {
    setContent(c)
    // Auto-select cheapest tier that fits the content size
    const idx = SIZE_PRESETS.findIndex(s => depthToBytes(s.depth) >= c.size)
    setSizeIdx(idx === -1 ? SIZE_PRESETS.length - 1 : idx)
    setStep('options')
  }

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault()
    setDragging(false)

    const item = e.dataTransfer.items[0]
    if (!item) return

    try {
      const { name, entries } = await readDroppedDirectory(item)
      const index = detectIndexDocument(entries) ?? 'index.html'
      acceptContent({ name, entries, size: totalSize(entries), indexDocument: index })
    } catch {
      // Fallback: user may have dropped a zip or wrong item
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function handleDirInput(e: React.ChangeEvent<HTMLInputElement>) {
    if (!e.target.files?.length) return
    const { name, entries } = fileListToEntries(e.target.files)
    const index = detectIndexDocument(entries) ?? 'index.html'
    acceptContent({ name, entries, size: totalSize(entries), indexDocument: index })
  }

  // ── Publish ───────────────────────────────────────────────────────────────

  async function publish() {
    if (!content || !cost) return

    setStep('publishing')
    setPublishError(null)

    try {
      setPublishPhase('Buying storage…')
      const res = await buyStamp.mutateAsync({
        amount: cost.amount,
        depth: selectedSize.depth,
        immutable: true,
        label: driveName.trim() || undefined,
      })
      const batchID = res.batchID

      const uploadResult = await upload({
        entries: content.entries,
        type: 'website',
        driveId: batchID,
        name: driveName.trim() || content.name,
        indexDocument: content.indexDocument,
        feedEnabled,
        feedTopic: feedTopic.trim() || driveName.trim() || content.name,
        onPhase: setPublishPhase,
        onProgress: setUploadProgress,
      })

      setResult(uploadResult)
      setStep('done')
    } catch (err) {
      setPublishError(err instanceof Error ? err.message : 'Something went wrong')
      setStep('options')
    }
  }

  function reset() {
    setStep('select')
    setContent(null)
    setDragging(false)
    setSizeIdx(1)
    setDurationIdx(1)
    setDriveName('')
    setFeedEnabled(false)
    setFeedTopic('')
    setPublishPhase('')
    setPublishError(null)
    setUploadProgress(null)
    setResult(null)
    setCopied(false)
    if (dirInputRef.current) dirInputRef.current.value = ''
  }

  // ─────────────────────────────────────────────────────────────────────────

  return (
    <div
      className="p-6 max-w-xl"
      onDragOver={
        step === 'select'
          ? e => {
              e.preventDefault()
              setDragging(true)
            }
          : undefined
      }
      onDragLeave={
        step === 'select'
          ? e => {
              if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false)
            }
          : undefined
      }
      onDrop={step === 'select' ? handleDrop : undefined}
    >
      <h1 className="text-base font-semibold uppercase tracking-widest mb-6" style={{ color: 'rgb(var(--fg-muted))' }}>
        Website Publisher
      </h1>

      {/* ── Step: Step dots (select / options) ── */}
      {(step === 'select' || step === 'options') && (
        <div className="flex items-center gap-2 mb-8">
          {(['select', 'options'] as const).map((s, i) => {
            const labels = ['Select', 'Options']
            const currentIdx = ['select', 'options'].indexOf(step)
            return (
              <div key={s} className="flex items-center gap-2">
                <div className="flex items-center gap-1.5">
                  <div
                    className="w-1.5 h-1.5 rounded-full transition-colors"
                    style={{ backgroundColor: i <= currentIdx ? 'rgb(var(--accent))' : 'rgb(var(--border))' }}
                  />
                  <span
                    className="text-[10px] uppercase tracking-widest"
                    style={{ color: i <= currentIdx ? 'rgb(var(--fg-muted))' : 'rgb(var(--border))' }}
                  >
                    {labels[i]}
                  </span>
                </div>
                {i < 1 && <ChevronRight size={10} style={{ color: 'rgb(var(--border))' }} />}
              </div>
            )
          })}
        </div>
      )}

      {/* ── Step 1: Select ── */}
      {step === 'select' && (
        <div className="space-y-4">
          {/* Drop zone */}
          <div
            onClick={beeOffline ? undefined : () => dirInputRef.current?.click()}
            className="rounded-xl border-2 border-dashed transition-colors"
            style={{
              borderColor: beeOffline ? 'rgb(var(--border))' : dragging ? 'rgb(var(--accent))' : 'rgb(var(--border))',
              backgroundColor: beeOffline ? 'rgba(0,0,0,0.02)' : dragging ? 'rgba(247,104,8,0.04)' : 'transparent',
              cursor: beeOffline ? 'default' : 'pointer',
            }}
          >
            {beeOffline ? (
              <div className="flex flex-col items-center gap-2 py-12 px-6 text-center">
                <div className="w-2 h-2 rounded-full bg-red-400" />
                <p className="text-sm font-medium" style={{ color: 'rgb(var(--fg-muted))' }}>
                  Bee node offline
                </p>
                <p className="text-xs" style={{ color: 'rgb(var(--fg-muted))' }}>
                  Start your node to publish a website
                </p>
              </div>
            ) : (
              <div className="flex flex-col items-center gap-3 py-12 px-6 text-center">
                <Globe size={26} style={{ color: 'rgb(var(--fg-muted))' }} />
                <div>
                  <p className="text-sm font-medium" style={{ color: 'rgb(var(--fg))' }}>
                    Drop your website folder here
                  </p>
                  <p className="text-xs mt-1" style={{ color: 'rgb(var(--fg-muted))' }}>
                    or click to browse
                  </p>
                </div>
              </div>
            )}
          </div>

          <p className="text-xs" style={{ color: 'rgb(var(--fg-muted))' }}>
            The folder should contain an <span className="font-mono">index.html</span> at its root. Swarm will serve it
            as a static website.
          </p>

          {/* Hidden directory input */}
          <input
            ref={dirInputRef}
            type="file"
            className="hidden"
            // @ts-expect-error — webkitdirectory is not in TS types but works in Electron/Chrome
            webkitdirectory="true"
            onChange={handleDirInput}
          />
        </div>
      )}

      {/* ── Step 2: Options ── */}
      {step === 'options' && content && (
        <div className="space-y-6">
          {/* Content summary */}
          <div className="rounded-lg border px-4 py-3 space-y-1" style={{ backgroundColor: 'rgb(var(--bg-surface))' }}>
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium truncate mr-4">{content.name}</span>
              <span className="text-xs shrink-0" style={{ color: 'rgb(var(--fg-muted))' }}>
                {formatBytes(content.size)}
              </span>
            </div>
            <p className="text-xs" style={{ color: 'rgb(var(--fg-muted))' }}>
              {content.entries.length} files
            </p>
            <div className="pt-1 flex items-center gap-2">
              <span className="text-xs" style={{ color: 'rgb(var(--fg-muted))' }}>
                Index file
              </span>
              <input
                type="text"
                value={content.indexDocument}
                onChange={e => setContent(c => (c ? { ...c, indexDocument: e.target.value } : c))}
                className="flex-1 text-xs rounded border px-2 py-1 font-mono focus:outline-none"
                style={{ backgroundColor: 'rgb(var(--bg))', color: 'rgb(var(--fg))' }}
              />
              {!content.entries.some(e => e.path === content.indexDocument) && (
                <span className="text-xs" style={{ color: '#facc15' }}>
                  not found
                </span>
              )}
            </div>
          </div>

          {/* Drive name */}
          <div>
            <p className="text-xs uppercase tracking-widest mb-2" style={{ color: 'rgb(var(--fg-muted))' }}>
              Drive name{' '}
              <span className="normal-case tracking-normal font-normal" style={{ color: 'rgb(var(--border))' }}>
                (optional)
              </span>
            </p>
            <input
              type="text"
              value={driveName}
              onChange={e => setDriveName(e.target.value)}
              placeholder="e.g. my-portfolio, docs-v2…"
              className="w-full rounded-lg border px-3 py-2 text-sm bg-transparent outline-none"
              style={{ borderColor: 'rgb(var(--border))', color: 'rgb(var(--fg))' }}
            />
          </div>

          {/* Size presets */}
          <div>
            <p className="text-xs uppercase tracking-widest mb-3" style={{ color: 'rgb(var(--fg-muted))' }}>
              Storage size
            </p>
            <div className="grid grid-cols-4 gap-2">
              {SIZE_PRESETS.map((s, i) => (
                <PlanButton key={s.label} label={s.label} selected={sizeIdx === i} onClick={() => setSizeIdx(i)} />
              ))}
            </div>
          </div>

          {/* Duration presets */}
          <div>
            <p className="text-xs uppercase tracking-widest mb-3" style={{ color: 'rgb(var(--fg-muted))' }}>
              How long
            </p>
            <div className="grid grid-cols-4 gap-2">
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

          {/* Cost display */}
          <div
            className="rounded-lg border px-4 py-3 flex items-center justify-between"
            style={{ backgroundColor: 'rgb(var(--bg-surface))' }}
          >
            <div>
              <p className="text-xs uppercase tracking-widest mb-0.5" style={{ color: 'rgb(var(--fg-muted))' }}>
                Estimated cost
              </p>
              <p className="text-sm font-semibold">{cost ? `${cost.bzzCost} BZZ` : '—'}</p>
            </div>
            <div className="text-right">
              <p className="text-xs uppercase tracking-widest mb-0.5" style={{ color: 'rgb(var(--fg-muted))' }}>
                Your balance
              </p>
              <p className="text-sm font-semibold" style={{ color: canAfford ? 'rgb(var(--fg))' : '#ef4444' }}>
                {bzzBalance !== null ? `${bzzBalance.toFixed(4)} BZZ` : '—'}
              </p>
            </div>
          </div>

          {!canAfford && (
            <div
              className="rounded-lg border px-4 py-3 flex items-center justify-between gap-4"
              style={{ backgroundColor: 'rgba(239,68,68,0.06)', borderColor: 'rgba(239,68,68,0.25)' }}
            >
              <div>
                <p className="text-xs font-semibold mb-0.5" style={{ color: '#ef4444' }}>
                  {bzzBalance === 0 ? 'Your wallet has no BZZ' : 'Not enough BZZ'}
                </p>
                <p className="text-xs" style={{ color: 'rgb(var(--fg-muted))' }}>
                  Swap xDAI to fund this upload.
                </p>
              </div>
              <button
                onClick={() => navigate('/account')}
                className="shrink-0 px-3 py-1.5 rounded-lg text-xs font-semibold"
                style={{ backgroundColor: 'rgb(var(--accent))', color: '#fff' }}
              >
                Swap xDAI → BZZ
              </button>
            </div>
          )}

          {/* Feed toggle */}
          <div className="rounded-lg border p-4 space-y-3" style={{ backgroundColor: 'rgb(var(--bg-surface))' }}>
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium">Permanent address</p>
                <p className="text-xs mt-0.5" style={{ color: 'rgb(var(--fg-muted))' }}>
                  One shareable link that always points to your latest version — even after you update the site.
                </p>
              </div>
              <button
                onClick={() => setFeedEnabled(v => !v)}
                className="relative w-10 h-5 rounded-full transition-colors shrink-0"
                style={{ backgroundColor: feedEnabled ? 'rgb(var(--accent))' : 'rgb(var(--border))' }}
              >
                <span
                  className="absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all"
                  style={{ left: feedEnabled ? '1.25rem' : '0.125rem' }}
                />
              </button>
            </div>

            {feedEnabled && (
              <>
                <div>
                  <label
                    className="text-xs uppercase tracking-widest block mb-2"
                    style={{ color: 'rgb(var(--fg-muted))' }}
                  >
                    Feed name
                  </label>
                  <input
                    type="text"
                    value={feedTopic}
                    onChange={e => setFeedTopic(e.target.value)}
                    placeholder={driveName.trim() || content.name}
                    className="w-full rounded-lg border px-3 py-2 text-sm focus:outline-none"
                    style={{ backgroundColor: 'rgb(var(--bg))', color: 'rgb(var(--fg))' }}
                  />
                </div>
              </>
            )}
          </div>


          <p className="text-xs leading-relaxed" style={{ color: 'rgb(var(--fg-muted))' }}>
            Storage is funded upfront. When it runs out, your content may become unavailable. You can extend it anytime
            from Drive.
          </p>

          {publishError && (
            <p
              className="text-xs px-3 py-2 rounded-lg"
              style={{ backgroundColor: 'rgba(239,68,68,0.1)', color: '#ef4444' }}
            >
              {publishError}
            </p>
          )}

          <div className="flex gap-3">
            <button
              onClick={() => setStep('select')}
              className="px-4 py-2 rounded-lg text-sm"
              style={{ color: 'rgb(var(--fg-muted))' }}
            >
              Back
            </button>
            <button
              onClick={publish}
              disabled={!canAfford || !cost}
              className="flex-1 px-4 py-2 rounded-lg text-sm font-semibold disabled:opacity-40"
              style={{ backgroundColor: 'rgb(var(--accent))', color: '#fff' }}
            >
              Publish
            </button>
          </div>
        </div>
      )}

      {/* ── Publishing ── */}
      {step === 'publishing' && (
        <div className="flex flex-col items-center gap-4 py-16">
          <RefreshCw size={24} className="animate-spin" style={{ color: 'rgb(var(--accent))' }} />
          <div className="text-center space-y-3 w-full max-w-xs">
            <p className="text-sm font-medium">{publishPhase || 'Publishing…'}</p>
            <p className="text-xs" style={{ color: 'rgb(var(--fg-muted))' }}>
              {content ? `${content.entries.length} files` : ''}
            </p>
            {uploadProgress !== null && (
              <div className="space-y-1.5">
                <div
                  className="h-1.5 rounded-full overflow-hidden w-full"
                  style={{ backgroundColor: 'rgb(var(--border))' }}
                >
                  <div
                    className="h-full rounded-full transition-all duration-200"
                    style={{ width: `${uploadProgress}%`, backgroundColor: 'rgb(var(--accent))' }}
                  />
                </div>
                <p className="text-xs tabular-nums" style={{ color: 'rgb(var(--fg-muted))' }}>
                  {uploadProgress}%
                </p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Done ── */}
      {step === 'done' && result && (
        <div className="space-y-6">
          <div className="flex items-center gap-3">
            <div
              className="w-8 h-8 rounded-full flex items-center justify-center shrink-0"
              style={{ backgroundColor: 'rgba(74,222,128,0.15)' }}
            >
              <Check size={16} color="#4ade80" />
            </div>
            <div>
              <p className="text-sm font-semibold">Published to Swarm</p>
              <p className="text-xs" style={{ color: 'rgb(var(--fg-muted))' }}>
                {driveName.trim() || content?.name}
              </p>
            </div>
          </div>

          {/* Feed manifest address — permanent shareable link */}
          {result.feedManifestAddress && (
            <div className="rounded-lg border p-4 space-y-2" style={{ backgroundColor: 'rgb(var(--bg-surface))' }}>
              <p className="text-xs uppercase tracking-widest" style={{ color: 'rgb(var(--fg-muted))' }}>
                Permanent address{' '}
                <span className="normal-case tracking-normal font-normal">
                  — always points to the latest version
                </span>
              </p>
              <p className="font-mono text-sm break-all">{result.feedManifestAddress}</p>
              <div className="flex gap-2 flex-wrap">
                <button
                  onClick={() => {
                    navigator.clipboard.writeText(result.feedManifestAddress!)
                    setCopied(true)
                    setTimeout(() => setCopied(false), 2000)
                  }}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium transition-colors"
                  style={{
                    backgroundColor: copied ? 'rgba(74,222,128,0.1)' : 'rgb(var(--bg))',
                    color: copied ? '#4ade80' : 'rgb(var(--fg-muted))',
                  }}
                >
                  {copied ? <Check size={12} /> : <Copy size={12} />}
                  {copied ? 'Copied' : 'Copy live link'}
                </button>
                <a
                  href={`${getBeeUrl()}/bzz/${result.feedManifestAddress}/`}
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium"
                  style={{ color: 'rgb(var(--fg-muted))' }}
                >
                  <ExternalLink size={12} />
                  Preview locally
                </a>
                <a
                  href={`${gatewayUrl}/bzz/${result.feedManifestAddress}/`}
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium"
                  style={{ color: 'rgb(var(--fg-muted))' }}
                >
                  <ExternalLink size={12} />
                  Open on gateway
                </a>
              </div>
            </div>
          )}

          <div className="rounded-lg border p-4 space-y-3" style={{ backgroundColor: 'rgb(var(--bg-surface))' }}>
            <p className="text-xs uppercase tracking-widest" style={{ color: 'rgb(var(--fg-muted))' }}>
              {result.feedManifestAddress ? 'Content hash (this version)' : 'Swarm hash'}
            </p>
            <p className="font-mono text-sm break-all">{result.hash}</p>
            {!result.feedManifestAddress && (
              <div className="flex gap-2 flex-wrap">
                <button
                  onClick={() => {
                    navigator.clipboard.writeText(result.hash)
                    setCopied(true)
                    setTimeout(() => setCopied(false), 2000)
                  }}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium transition-colors"
                  style={{
                    backgroundColor: copied ? 'rgba(74,222,128,0.1)' : 'rgb(var(--bg))',
                    color: copied ? '#4ade80' : 'rgb(var(--fg-muted))',
                  }}
                >
                  {copied ? <Check size={12} /> : <Copy size={12} />}
                  {copied ? 'Copied' : 'Copy hash'}
                </button>
                <a
                  href={`${getBeeUrl()}/bzz/${result.hash}/`}
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium"
                  style={{ color: 'rgb(var(--fg-muted))' }}
                >
                  <ExternalLink size={12} />
                  Preview locally
                </a>
                <a
                  href={`${gatewayUrl}/bzz/${result.hash}/`}
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium"
                  style={{ color: 'rgb(var(--fg-muted))' }}
                >
                  <ExternalLink size={12} />
                  Open on gateway
                </a>
              </div>
            )}
          </div>

          <div className="flex gap-3">
            <button
              onClick={() => navigate('/drive')}
              className="flex-1 px-4 py-2 rounded-lg text-sm font-semibold border"
              style={{ backgroundColor: 'rgb(var(--bg-surface))', color: 'rgb(var(--fg))' }}
            >
              View in Drive
            </button>
            <button
              onClick={reset}
              className="flex-1 px-4 py-2 rounded-lg text-sm font-semibold border"
              style={{ backgroundColor: 'rgb(var(--bg-surface))', color: 'rgb(var(--fg))' }}
            >
              Publish another
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
