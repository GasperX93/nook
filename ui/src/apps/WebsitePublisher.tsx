import { Check, ChevronRight, Copy, ExternalLink, Globe, Link, Loader2 } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { calcStampCost, depthToBytes, DURATION_PRESETS, getBeeUrl, plurToBzz, SIZE_PRESETS } from '../api/bee'
import { useBeeHealth, useBuyStamp, useChainState, useWallet } from '../api/queries'
import { useAppStore } from '../store/app'
import { useUpload } from '../hooks/useUpload'
import { useUploadHistory } from '../hooks/useUploadHistory'
import ENSModal from '../components/ENSModal'
import { bzzLink } from '../lib/ens-gateway'
import { formatBytes } from '../lib/format-bytes'
import PublishProgress from '../components/PublishProgress'
import { serverApi } from '../api/server'
import { UPLOAD_PAUSED, UPLOAD_RESUMING, UPLOAD_STEP_LOCAL, UPLOAD_STEP_NETWORK } from '../lib/transfer-labels'
import {
  type BoughtStamp,
  loadBoughtStamp,
  PUBLISH_JOB_HREF,
  publishTransferId,
  saveBoughtStamp,
  usePublishJob,
} from '../store/publish-job'
import { useTransfersStore } from '../store/transfers'
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

/** The short step name on the sidebar card, from the publish phase. */
function cardLabel(phase: string): string {
  // A paused publish says so on its card, whichever step Bee stopped in (R8-3).
  if (phase === UPLOAD_PAUSED || phase === UPLOAD_RESUMING) return phase

  if (phase.startsWith('Buying')) return 'Buying storage'

  if (phase === UPLOAD_STEP_LOCAL || phase.startsWith('Encrypting')) return 'Copying'

  if (phase === UPLOAD_STEP_NETWORK || phase.startsWith('Still storing')) return 'Storing'

  if (phase.startsWith('Creating the permanent address')) return 'Finishing'

  return 'Preparing'
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

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
  const [feedEnabled, setFeedEnabled] = useState(true)
  const [feedTopic, setFeedTopic] = useState('')

  // A stamp bought by a previous (failed) publish attempt. Reused on retry so
  // the user isn't charged twice — but only while the size/duration selection
  // still matches what was paid for; changing either buys fresh. Kept in
  // localStorage (R7-5): leaving the page or reloading must not forget it.
  const [boughtStamp, setBoughtStampState] = useState<BoughtStamp | null>(loadBoughtStamp)
  const setBoughtStamp = (stamp: BoughtStamp | null) => {
    saveBoughtStamp(stamp)
    setBoughtStampState(stamp)
  }

  // The publish itself is an app-wide job (R7-5): it keeps running when the
  // user leaves, and its progress/result live in a store the sidebar card
  // reads too — so this page shows it again on return.
  const job = usePublishJob(state => state.job)
  const view: Step = job?.status === 'running' ? 'publishing' : job?.status === 'done' ? 'done' : step
  const result = job?.status === 'done' ? (job.result ?? null) : null
  const publishError = job?.status === 'failed' ? (job.error ?? 'Something went wrong') : null
  // Progress view (R4-7): the upload's tag feeds the same honest propagation
  // visual as Drive; steps without measurable progress show elapsed time.
  const propagationTransfer = useTransfersStore(state =>
    !job || job.tagUid === null ? undefined : state.transfers.find(t => t.id === `tag:${job.tagUid}`),
  )

  // Done state
  const [copied, setCopied] = useState(false)
  const [ensModalOpen, setEnsModalOpen] = useState(false)
  const [linkedDomain, setLinkedDomain] = useState('')

  const dirInputRef = useRef<HTMLInputElement>(null)
  const navigate = useNavigate()
  const location = useLocation()

  // Reset when the sidebar item is clicked (new location.key) — except while
  // a publish runs, or when the sidebar card asked to see the job (?job=1):
  // then show its progress or result. A failed job restores its options.
  // eslint-disable-next-line
  useEffect(() => {
    const current = usePublishJob.getState().job
    const showJob = new URLSearchParams(location.search).get('job') === '1'

    if (current?.status === 'running') return

    if (current && showJob) {
      if (current.status === 'failed') restoreFrom(current)

      return
    }
    reset()
  }, [location.key])

  function restoreFrom(failed: NonNullable<typeof job>) {
    setContent(failed.content)
    setSizeIdx(failed.selection.sizeIdx)
    setDurationIdx(failed.selection.durationIdx)
    setDriveName(failed.selection.driveName)
    setFeedTopic(failed.selection.feedTopic)
    setFeedEnabled(failed.feedEnabled)
    setStep('options')
  }

  const { isError: beeOffline, isSuccess: beeOnline } = useBeeHealth()
  const { data: chainState } = useChainState()
  const { data: wallet } = useWallet()
  const { gatewayUrl } = useAppStore()
  const buyStamp = useBuyStamp()
  const { upload, setEnsDomain } = useUpload()
  const { records } = useUploadHistory()

  const selectedSize = SIZE_PRESETS[sizeIdx]
  const selectedDuration = DURATION_PRESETS[durationIdx]
  const cost = chainState
    ? calcStampCost(
        selectedSize.depth,
        selectedDuration.months,
        chainState.currentPrice,
        chainState.minimumValidityBlocks,
      )
    : null
  const bzzBalance = wallet ? Number(plurToBzz(wallet.bzzBalance)) : null
  // Storage already paid for by a failed attempt with the same selection —
  // retry must not re-buy, and must not be blocked by the balance check.
  const reusableStamp =
    boughtStamp && boughtStamp.sizeIdx === sizeIdx && boughtStamp.durationIdx === durationIdx ? boughtStamp : null
  const canAfford = cost && bzzBalance !== null ? bzzBalance >= Number(cost.bzzCost) : true

  // R5-14: the Publish button must say WHY it's disabled, right where it is.
  // The longest duration the wallet covers at the chosen size — offered as a
  // one-click fix when the current choice costs more than the balance.
  const affordableDuration = (() => {
    if (!chainState || bzzBalance === null || canAfford) return null

    for (let i = DURATION_PRESETS.length - 1; i >= 0; i--) {
      const c = calcStampCost(
        selectedSize.depth,
        DURATION_PRESETS[i].months,
        chainState.currentPrice,
        chainState.minimumValidityBlocks,
      )

      if (bzzBalance >= Number(c.bzzCost)) return { idx: i, cost: c.bzzCost }
    }

    return null
  })()
  const publishBlocker: 'price' | 'funds' | null = reusableStamp ? null : !cost ? 'price' : !canAfford ? 'funds' : null
  const xbzz = (v: string | number) => Number(v).toFixed(2)
  // Permanent address = this node + the name (a feed topic). Another site
  // already published under the same name would be repointed here.
  const addressName = content ? feedTopic.trim() || driveName.trim() || content.name : ''
  const addressClash =
    feedEnabled && addressName ? records.find(r => r.hasFeed && r.feedTopic === addressName) : undefined

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
    // eslint-disable-next-line
  }, [])

  function handleDirInput(e: React.ChangeEvent<HTMLInputElement>) {
    if (!e.target.files?.length) return
    const { name, entries } = fileListToEntries(e.target.files)
    const index = detectIndexDocument(entries) ?? 'index.html'
    acceptContent({ name, entries, size: totalSize(entries), indexDocument: index })
  }

  // ── Publish ───────────────────────────────────────────────────────────────

  async function publish() {
    if (!content || (!cost && !reusableStamp)) return

    const jobId = crypto.randomUUID()
    const siteName = driveName.trim() || content.name
    const transferId = publishTransferId(jobId)
    const jobs = usePublishJob.getState()
    const transfers = useTransfersStore.getState()
    const firstPhase = reusableStamp ? 'Getting storage ready…' : 'Buying storage…'

    jobs.start({
      id: jobId,
      siteName,
      status: 'running',
      phase: firstPhase,
      uploadProgress: null,
      tagUid: null,
      skippedBuy: Boolean(reusableStamp),
      feedEnabled,
      fileCount: content.entries.length,
      content,
      selection: { sizeIdx, durationIdx, driveName, feedTopic },
    })
    // One sidebar card for the whole publish, from the first step (R7-5).
    transfers.begin({
      id: transferId,
      kind: 'upload',
      name: siteName,
      phase: firstPhase,
      label: cardLabel(firstPhase),
      href: PUBLISH_JOB_HREF,
      doneLabel: 'Published',
    })
    // Everything below keeps running when the user leaves this page — it
    // only writes to the stores, never to this component.
    const onPhase = (phase: string) => {
      const waiting = phase === UPLOAD_PAUSED || phase === UPLOAD_RESUMING

      // Remember the step a pause interrupts — the page may be reopened mid-pause.
      usePublishJob.getState().patch(jobId, waiting ? { phase } : { phase, stepPhase: phase })
      useTransfersStore.getState().update(transferId, { phase, label: cardLabel(phase), pct: null })
    }
    const onProgress = (pct: number | null) => {
      usePublishJob.getState().patch(jobId, { uploadProgress: pct })
      useTransfersStore.getState().update(transferId, { pct })
    }

    // Declared out here so the failure bell can say whether storage is paid for.
    let batchID: string | undefined

    try {
      if (reusableStamp) {
        batchID = reusableStamp.batchID
      } else {
        const res = await buyStamp.mutateAsync({
          amount: cost!.amount,
          depth: selectedSize.depth,
          immutable: true,
          label: driveName.trim() || undefined,
        })
        batchID = res.batchID
        setBoughtStamp({ batchID, sizeIdx, durationIdx })
      }

      const uploadResult = await upload({
        entries: content.entries,
        type: 'website',
        driveId: batchID!,
        name: siteName,
        indexDocument: content.indexDocument,
        feedEnabled,
        feedTopic: feedTopic.trim() || driveName.trim() || content.name,
        onPhase,
        onProgress,
        onTag: uid => usePublishJob.getState().patch(jobId, { tagUid: uid }),
      })

      setBoughtStamp(null)
      usePublishJob.getState().patch(jobId, { status: 'done', result: uploadResult, uploadProgress: null })
      useTransfersStore.getState().finish(transferId)
      serverApi
        .createNotification({
          type: 'info',
          title: 'Website published',
          body: `“${siteName}” is live on Swarm.`,
          // Durable: the job lives in memory, the drive's record survives reloads.
          link: `/drive?open=${batchID}`,
        })
        .catch(() => undefined)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Something went wrong'

      usePublishJob.getState().patch(jobId, { status: 'failed', error: message })
      useTransfersStore.getState().finish(transferId, 'failed')
      setStep('options')
      // The user may be elsewhere — a failure must not vanish with the card.
      serverApi
        .createNotification({
          type: 'info',
          title: 'Publishing failed',
          body: `“${siteName}” wasn’t published: ${message}${
            batchID ? ' Its storage is paid for — Publish again reuses it.' : ''
          }`,
          link: PUBLISH_JOB_HREF,
        })
        .catch(() => undefined)
    }
  }

  function reset() {
    usePublishJob.getState().clear()
    setStep('select')
    setContent(null)
    setDragging(false)
    setSizeIdx(1)
    setDurationIdx(1)
    setDriveName('')
    setFeedEnabled(true)
    setFeedTopic('')
    // boughtStamp is NOT cleared: it is paid-for storage a retry must reuse.
    setCopied(false)

    if (dirInputRef.current) dirInputRef.current.value = ''
  }

  // ─────────────────────────────────────────────────────────────────────────

  return (
    <div
      className="p-6 max-w-xl"
      onDragOver={
        view === 'select'
          ? e => {
              e.preventDefault()
              setDragging(true)
            }
          : undefined
      }
      onDragLeave={
        view === 'select'
          ? e => {
              if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false)
            }
          : undefined
      }
      onDrop={view === 'select' ? handleDrop : undefined}
    >
      {/* ── Step: Step dots (select / options) ── */}
      {(view === 'select' || view === 'options') && (
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
      {view === 'select' && (
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
      {view === 'options' && content && (
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
              <p className="text-sm font-semibold">{cost ? `${cost.bzzCost} xBZZ` : '—'}</p>
            </div>
            <div className="text-right">
              <p className="text-xs uppercase tracking-widest mb-0.5" style={{ color: 'rgb(var(--fg-muted))' }}>
                Your balance
              </p>
              <p className="text-sm font-semibold" style={{ color: canAfford ? 'rgb(var(--fg))' : '#ef4444' }}>
                {bzzBalance !== null ? `${bzzBalance.toFixed(4)} xBZZ` : '—'}
              </p>
            </div>
          </div>

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
                    Permanent address name
                  </label>
                  <input
                    type="text"
                    value={feedTopic}
                    onChange={e => setFeedTopic(e.target.value)}
                    placeholder={driveName.trim() || content.name}
                    className="w-full rounded-lg border px-3 py-2 text-sm focus:outline-none"
                    style={{ backgroundColor: 'rgb(var(--bg))', color: 'rgb(var(--fg))' }}
                  />
                  {/* The address is your node + this name: the same name means the
                      same address, so publishing would repoint an existing site. */}
                  {addressClash && (
                    <p className="text-xs mt-2" style={{ color: '#d97706' }}>
                      Your site “{addressClash.name}” already uses this name. Publishing will point its permanent
                      address to this site instead — choose another name to keep both, or{' '}
                      <button
                        type="button"
                        onClick={() => navigate(`/drive?open=${addressClash.driveId}`)}
                        className="underline font-medium"
                      >
                        update “{addressClash.name}”
                      </button>{' '}
                      in Drive to replace it.
                    </p>
                  )}
                </div>
              </>
            )}
          </div>

          <p className="text-xs leading-relaxed" style={{ color: 'rgb(var(--fg-muted))' }}>
            Storage is funded upfront. When it runs out, your content may become unavailable. You can extend it anytime
            from Drive.
          </p>

          {publishError && (
            <div className="text-xs px-3 py-2 rounded-lg space-y-1" style={{ backgroundColor: 'rgba(239,68,68,0.1)' }}>
              <p style={{ color: '#ef4444' }}>{publishError}</p>
              {reusableStamp && (
                <p style={{ color: 'rgb(var(--fg-muted))' }}>
                  Your storage is already paid for — pressing Publish will reuse it and retry the upload.
                </p>
              )}
            </div>
          )}

          {/* Why Publish is disabled — next to the button (R5-14). */}
          {publishBlocker === 'price' && (
            <div className="flex items-start gap-2 text-xs" role="status" style={{ color: 'rgb(var(--fg-muted))' }}>
              <Loader2 size={12} className="animate-spin shrink-0 mt-0.5" />
              <span>
                Checking the current storage price — your node is still connecting to the blockchain. This usually takes
                a minute.
              </span>
            </div>
          )}
          {publishBlocker === 'funds' && cost && (
            <div
              className="rounded-lg border px-4 py-3 space-y-2"
              role="status"
              style={{ backgroundColor: 'rgba(239,68,68,0.06)', borderColor: 'rgba(239,68,68,0.25)' }}
            >
              <p className="text-xs" style={{ color: 'rgb(var(--fg))' }}>
                Needs {xbzz(cost.bzzCost)} xBZZ — your wallet has {xbzz(bzzBalance ?? 0)} xBZZ.
              </p>
              <div className="flex flex-wrap gap-2">
                {affordableDuration && (
                  <button
                    onClick={() => setDurationIdx(affordableDuration.idx)}
                    className="px-3 py-1.5 rounded-lg text-xs font-semibold border"
                    style={{ borderColor: 'rgb(var(--border))', color: 'rgb(var(--fg))' }}
                  >
                    Use {DURATION_PRESETS[affordableDuration.idx].label} · {xbzz(affordableDuration.cost)} xBZZ
                  </button>
                )}
                <button
                  onClick={() => navigate('/account')}
                  className="px-3 py-1.5 rounded-lg text-xs font-semibold"
                  style={{ backgroundColor: 'rgb(var(--accent))', color: 'rgb(var(--primary-foreground))' }}
                >
                  Add xBZZ
                </button>
              </div>
            </div>
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
              disabled={reusableStamp ? false : !canAfford || !cost}
              className="flex-1 px-4 py-2 rounded-lg text-sm font-semibold disabled:opacity-40"
              style={{ backgroundColor: 'rgb(var(--accent))', color: 'rgb(var(--primary-foreground))' }}
            >
              Publish
            </button>
          </div>
        </div>
      )}

      {/* ── Publishing ── */}
      {view === 'publishing' && job && (
        <PublishProgress
          phase={job.phase}
          stepPhase={job.stepPhase}
          fileCount={job.fileCount}
          uploadProgress={job.uploadProgress}
          propagationTransfer={propagationTransfer}
          skippedBuy={job.skippedBuy}
          feedEnabled={job.feedEnabled}
        />
      )}

      {/* ── Done ── */}
      {view === 'done' && result && (
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
                {job?.siteName}
              </p>
            </div>
          </div>

          {/* Feed manifest address — permanent shareable link */}
          {result.feedManifestAddress && (
            <div className="rounded-lg border p-4 space-y-2" style={{ backgroundColor: 'rgb(var(--bg-surface))' }}>
              <p className="text-xs uppercase tracking-widest" style={{ color: 'rgb(var(--fg-muted))' }}>
                Permanent address{' '}
                <span className="normal-case tracking-normal font-normal">— always points to the latest version</span>
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

          {linkedDomain && (
            <div
              className="flex items-center gap-3 rounded-lg p-3"
              style={{ backgroundColor: 'rgba(74,222,128,0.08)' }}
            >
              <Globe size={13} style={{ color: '#4ade80' }} />
              {/* eth.limo (main) and bzz.link are both ENS gateways — they
                  resolve the ENS name, not a raw hash. bzz.link uses the path
                  form for subnames (R5-6, lib/ens-gateway). */}
              <a
                href={`https://${linkedDomain}.limo`}
                target="_blank"
                rel="noreferrer"
                className="text-xs font-medium transition-opacity hover:opacity-80"
                style={{ color: '#4ade80' }}
              >
                {linkedDomain}.limo
              </a>
              {bzzLink(linkedDomain) && (
                <a
                  href={bzzLink(linkedDomain)!.url}
                  target="_blank"
                  rel="noreferrer"
                  className="text-xs font-medium transition-opacity hover:opacity-80"
                  style={{ color: '#4ade80' }}
                >
                  {bzzLink(linkedDomain)!.label}
                </a>
              )}
            </div>
          )}

          <div className="flex gap-3">
            <button
              onClick={() => navigate('/drive')}
              className="flex-1 px-4 py-2 rounded-lg text-sm font-semibold border"
              style={{ backgroundColor: 'rgb(var(--bg-surface))', color: 'rgb(var(--fg))' }}
            >
              View in Drive
            </button>
            <button
              onClick={() => setEnsModalOpen(true)}
              className="flex-1 px-4 py-2 rounded-lg text-sm font-semibold flex items-center justify-center gap-1.5 border"
              style={{ backgroundColor: 'rgb(var(--bg-surface))', color: 'rgb(var(--fg))' }}
            >
              <Link size={13} />
              Link ENS domain
            </button>
          </div>
          <button
            onClick={reset}
            className="text-xs transition-colors hover:underline mx-auto block"
            style={{ color: 'rgb(var(--fg-muted))' }}
          >
            Publish another
          </button>
        </div>
      )}

      {result && (
        <ENSModal
          isOpen={ensModalOpen}
          onClose={() => setEnsModalOpen(false)}
          swarmHash={result.hash}
          feedManifest={result.feedManifestAddress}
          currentDomain={linkedDomain || undefined}
          onLinked={domain => {
            setLinkedDomain(domain)
            setEnsDomain(result.recordId, domain)
          }}
        />
      )}
    </div>
  )
}
