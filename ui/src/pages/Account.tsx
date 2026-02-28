import { AlertTriangle, Plus, RefreshCw } from 'lucide-react'
import { useState } from 'react'
import { calcStampCost, depthToCapacity, DURATION_PRESETS, plurToBzz, SIZE_PRESETS, type Stamp } from '../api/bee'
import { useBuyStamp, useChainState, useStamps, useTopupStamp, useWallet } from '../api/queries'
import Wallet from './Wallet'

// ─── Helpers ──────────────────────────────────────────────────────────────────

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

// ─── StampTypeBadge ────────────────────────────────────────────────────────────

function StampTypeBadge({ immutable }: { immutable: boolean }) {
  const [show, setShow] = useState(false)

  return (
    <span className="relative" onMouseEnter={() => setShow(true)} onMouseLeave={() => setShow(false)}>
      <span
        className="text-[10px] px-1.5 py-0.5 rounded font-semibold uppercase tracking-widest cursor-default whitespace-nowrap"
        style={
          immutable
            ? { backgroundColor: 'rgba(150,150,150,0.12)', color: 'rgb(var(--fg-muted))' }
            : { backgroundColor: 'rgba(74,222,128,0.1)', color: '#4ade80' }
        }
      >
        {immutable ? 'Immutable' : 'Mutable'}
      </span>
      {show && (
        <span
          className="absolute bottom-full left-0 mb-2 w-56 rounded-lg border px-3 py-2 text-xs leading-relaxed z-50 pointer-events-none"
          style={{
            backgroundColor: 'rgb(var(--bg-surface))',
            color: 'rgb(var(--fg-muted))',
            borderColor: 'rgb(var(--border))',
          }}
        >
          {immutable
            ? 'Content at the same address can never be replaced.'
            : 'Content at the same address can be overwritten. Required for feeds.'}
        </span>
      )}
    </span>
  )
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

// ─── TopUpModal ────────────────────────────────────────────────────────────────

function TopUpModal({ stamp, onClose }: { stamp: Stamp; onClose: () => void }) {
  const [durationIdx, setDurationIdx] = useState(1)
  const { data: chainState } = useChainState()
  const topup = useTopupStamp()

  const cost = chainState
    ? calcStampCost(stamp.depth, DURATION_PRESETS[durationIdx].months, chainState.currentPrice)
    : null

  async function doTopup() {
    if (!cost) return
    await topup.mutateAsync({ id: stamp.batchID, amount: cost.amount })
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
          <p className="text-sm font-semibold">Top up drive</p>
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

        <div className="flex gap-3">
          <button
            onClick={onClose}
            className="flex-1 py-2 rounded-lg text-sm"
            style={{ color: 'rgb(var(--fg-muted))' }}
          >
            Cancel
          </button>
          <button
            onClick={doTopup}
            disabled={topup.isPending || !cost}
            className="flex-1 py-2 rounded-lg text-sm font-semibold disabled:opacity-40"
            style={{ backgroundColor: 'rgb(var(--accent))', color: '#fff' }}
          >
            {topup.isPending ? 'Topping up…' : 'Top up'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── BuyModal ──────────────────────────────────────────────────────────────────

function BuyModal({ onClose }: { onClose: () => void }) {
  const { data: chainState } = useChainState()
  const { data: wallet } = useWallet()
  const buyStamp = useBuyStamp()

  const [driveLabel, setDriveLabel] = useState('')
  const [sizeIdx, setSizeIdx] = useState(1)
  const [durationIdx, setDurationIdx] = useState(1)
  const [stampImmutable, setStampImmutable] = useState(false)
  const [buying, setBuying] = useState(false)
  const [buyDone, setBuyDone] = useState(false)
  const [buyError, setBuyError] = useState<string | null>(null)

  const selectedSize = SIZE_PRESETS[sizeIdx]
  const selectedDuration = DURATION_PRESETS[durationIdx]
  const cost = chainState ? calcStampCost(selectedSize.depth, selectedDuration.months, chainState.currentPrice) : null
  const bzzBalance = wallet ? Number(plurToBzz(wallet.bzzBalance)) : null
  const canAfford = cost && bzzBalance !== null ? bzzBalance >= Number(cost.bzzCost) : true

  async function doBuy() {
    if (!cost) return
    setBuying(true)
    setBuyError(null)
    setBuyDone(false)
    try {
      await buyStamp.mutateAsync({
        amount: cost.amount,
        depth: selectedSize.depth,
        immutable: stampImmutable,
        label: driveLabel.trim() || undefined,
      })
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

        {/* Label */}
        <div>
          <p className="text-xs uppercase tracking-widest mb-2" style={{ color: 'rgb(var(--fg-muted))' }}>
            Name <span style={{ color: 'rgb(var(--border))' }}>(optional)</span>
          </p>
          <input
            type="text"
            value={driveLabel}
            onChange={e => setDriveLabel(e.target.value)}
            placeholder="e.g. Website backup, Photos 2024…"
            className="w-full rounded-lg border px-3 py-2 text-sm focus:outline-none"
            style={{ backgroundColor: 'rgb(var(--bg))', color: 'rgb(var(--fg))' }}
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

        {/* Type */}
        <div>
          <p className="text-xs uppercase tracking-widest mb-2" style={{ color: 'rgb(var(--fg-muted))' }}>
            Type
          </p>
          <div className="flex gap-2">
            {(['mutable', 'immutable'] as const).map(type => {
              const isImmutable = type === 'immutable'
              const selected = stampImmutable === isImmutable

              return (
                <button
                  key={type}
                  onClick={() => setStampImmutable(isImmutable)}
                  className="px-4 py-2 rounded-lg border text-sm font-medium transition-all capitalize"
                  style={{
                    borderColor: selected ? 'rgb(var(--accent))' : 'rgb(var(--border))',
                    backgroundColor: selected ? 'rgba(247,104,8,0.08)' : 'transparent',
                    color: selected ? 'rgb(var(--fg))' : 'rgb(var(--fg-muted))',
                  }}
                >
                  {type}
                </button>
              )
            })}
          </div>
        </div>

        {/* Cost */}
        {cost && (
          <p className="text-sm">
            <span style={{ color: 'rgb(var(--fg-muted))' }}>Estimated cost: </span>
            <span className="font-semibold">{cost.bzzCost} BZZ</span>
            {!canAfford && (
              <span className="ml-2 text-xs" style={{ color: '#ef4444' }}>
                Insufficient BZZ
              </span>
            )}
          </p>
        )}

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
            disabled={buying || !cost || !canAfford || buyDone}
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

// ─── DriveRow (compact single-line stamp) ──────────────────────────────────────

function DriveRow({ stamp, onTopUp }: { stamp: Stamp; onTopUp: () => void }) {
  const MAX_TTL = 365 * 24 * 3600
  const pct = Math.min((stamp.batchTTL / MAX_TTL) * 100, 100)
  const color = ttlColor(stamp.batchTTL)
  const totalBuckets = 1 << (stamp.depth - stamp.bucketDepth)
  const utilPct = totalBuckets > 0 ? Math.round((stamp.utilization / totalBuckets) * 100) : 0

  return (
    <div
      className="flex items-center gap-3 px-2 py-2 transition-colors hover:bg-white/[0.02]"
    >
      {/* Size + badge */}
      <div className="flex items-center gap-1.5 shrink-0 w-36">
        <span className="text-sm font-semibold">{depthToCapacity(stamp.depth)}</span>
        <StampTypeBadge immutable={stamp.immutableFlag} />
      </div>

      {/* Name */}
      <p
        className="flex-1 min-w-0 text-xs truncate font-mono"
        style={{ color: stamp.label ? 'rgb(var(--fg))' : 'rgb(var(--fg-muted))' }}
      >
        {stamp.label || `${stamp.batchID.slice(0, 5)}…`}
      </p>

      {/* Usage */}
      <span className="text-xs shrink-0 w-12 text-right tabular-nums" style={{ color: 'rgb(var(--fg-muted))' }}>
        {utilPct}%
      </span>

      {/* Expires in: bar + text */}
      <div className="shrink-0 flex items-center gap-2 w-40">
        <div className="flex-1 h-1 rounded-full" style={{ backgroundColor: 'rgb(var(--border))' }}>
          <div className="h-1 rounded-full" style={{ width: `${pct}%`, backgroundColor: color }} />
        </div>
        <span className="text-xs font-medium whitespace-nowrap w-10 text-right tabular-nums" style={{ color }}>
          {ttlToDays(stamp.batchTTL)}
        </span>
      </div>

      {/* Action */}
      <div className="shrink-0 w-24 flex justify-end">
        {!stamp.usable ? (
          <span
            className="text-[10px] px-1.5 py-0.5 rounded font-semibold uppercase tracking-widest animate-pulse"
            style={{ backgroundColor: 'rgba(247,104,8,0.1)', color: 'rgb(var(--accent))' }}
          >
            Confirming
          </span>
        ) : (
          <button
            onClick={onTopUp}
            className="text-xs font-medium transition-colors"
            style={{ color: 'rgb(var(--fg-muted))' }}
          >
            Top up
          </button>
        )}
      </div>
    </div>
  )
}

// ─── Column headers ────────────────────────────────────────────────────────────

function DriveListHeader() {
  return (
    <div className="flex items-center gap-3 px-2 py-1.5">
      {/* size + badge col */}
      <div className="shrink-0 w-36" />
      {/* Name */}
      <p className="flex-1 min-w-0 text-[10px] uppercase tracking-widest" style={{ color: 'rgb(var(--fg-muted))' }}>
        Name
      </p>
      {/* Usage */}
      <p
        className="shrink-0 w-12 text-right text-[10px] uppercase tracking-widest"
        style={{ color: 'rgb(var(--fg-muted))' }}
      >
        Usage
      </p>
      {/* Expires in */}
      <p className="shrink-0 w-40 text-[10px] uppercase tracking-widest" style={{ color: 'rgb(var(--fg-muted))' }}>
        Expires in
      </p>
      {/* action col */}
      <div className="shrink-0 w-24" />
    </div>
  )
}

// ─── My Storage tab ────────────────────────────────────────────────────────────

function MyStorage() {
  const { data: stamps, isLoading } = useStamps()
  const [toppingUp, setToppingUp] = useState<Stamp | null>(null)
  const [buyOpen, setBuyOpen] = useState(false)

  const allStamps = stamps ?? []
  const warnLowTtl = allStamps.some(s => s.usable && s.batchTTL < 7 * 86400)
  const driveLabel = allStamps.length === 1 ? 'My drive' : 'My drives'

  if (isLoading) {
    return (
      <p className="text-sm mt-4" style={{ color: 'rgb(var(--fg-muted))' }}>
        Loading…
      </p>
    )
  }

  return (
    <div className="space-y-4">
      {/* TTL warning banner */}
      {warnLowTtl && (
        <div
          className="flex items-center gap-2 px-4 py-3 rounded-lg text-xs"
          style={{ backgroundColor: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.2)' }}
        >
          <AlertTriangle size={13} style={{ color: '#f59e0b' }} className="shrink-0" />
          <span style={{ color: '#f59e0b' }}>
            One or more drives will expire in less than 30 days. Top up to avoid losing storage.
          </span>
        </div>
      )}

      {/* Section heading + New drive button */}
      <div className="flex items-center justify-between">
        <p className="text-xs uppercase tracking-widest font-semibold" style={{ color: 'rgb(var(--fg-muted))' }}>
          {allStamps.length === 0 ? 'My drives' : driveLabel}
        </p>
        <button
          onClick={() => setBuyOpen(true)}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold"
          style={{ backgroundColor: 'rgb(var(--accent))', color: '#fff' }}
        >
          <Plus size={12} />
          New drive
        </button>
      </div>

      {/* Drive list */}
      {allStamps.length === 0 ? (
        <p className="text-sm py-2" style={{ color: 'rgb(var(--fg-muted))' }}>
          No drives yet. Create one to start uploading to Swarm.
        </p>
      ) : (
        <div className="divide-y" style={{ borderColor: 'rgb(var(--border))' }}>
          <DriveListHeader />
          {allStamps.map(stamp => (
            <DriveRow key={stamp.batchID} stamp={stamp} onTopUp={() => setToppingUp(stamp)} />
          ))}
        </div>
      )}

      {/* Modals */}
      {toppingUp && <TopUpModal stamp={toppingUp} onClose={() => setToppingUp(null)} />}
      {buyOpen && <BuyModal onClose={() => setBuyOpen(false)} />}
    </div>
  )
}

// ─── Account page ──────────────────────────────────────────────────────────────

export default function Account() {
  const [tab, setTab] = useState<'wallet' | 'storage'>('wallet')

  return (
    <div className="p-6 max-w-4xl">
      <h1 className="text-base font-semibold uppercase tracking-widest mb-5" style={{ color: 'rgb(var(--fg-muted))' }}>
        Account
      </h1>

      {/* Tab bar */}
      <div className="flex gap-1 mb-6 border-b" style={{ borderColor: 'rgb(var(--border))' }}>
        {(['wallet', 'storage'] as const).map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className="px-4 py-2 text-sm font-medium transition-colors relative"
            style={{ color: tab === t ? 'rgb(var(--fg))' : 'rgb(var(--fg-muted))' }}
          >
            {t === 'storage' ? 'My Storage' : 'Wallet'}
            {tab === t && (
              <span
                className="absolute bottom-0 left-0 right-0 h-0.5 rounded-t"
                style={{ backgroundColor: 'rgb(var(--accent))' }}
              />
            )}
          </button>
        ))}
      </div>

      {tab === 'wallet' && <Wallet />}
      {tab === 'storage' && <MyStorage />}
    </div>
  )
}
