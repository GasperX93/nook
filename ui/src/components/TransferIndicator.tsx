import { ArrowDownToLine, ArrowUpFromLine, Check } from 'lucide-react'
import { useNavigate } from 'react-router-dom'

import { waitLabel } from '../lib/transfer-labels'
import { etaText, type TransferEntry, useTransfersStore } from '../store/transfers'

/** Where clicking a transfer goes (R5-1): its own drive, not just "Drive" (a no-op when already there). */
function destination(t: TransferEntry): string {
  if (t.driveId) return `/drive?open=${t.driveId}`

  if (t.id.startsWith('dl:shared:')) return '/drive?tab=shared'

  return '/drive'
}

function statusText(t: TransferEntry): string {
  if (t.status === 'done') return t.kind === 'upload' ? 'Stored' : 'Saved'

  if (t.status === 'failed') return 'Failed'

  const waiting = waitLabel(t.waiting)

  if (waiting) return waiting

  const verb = t.label ?? (t.kind === 'upload' ? 'Storing' : 'Saving')
  const pct = t.pct !== null ? ` · ${t.pct}%` : '…'
  // Coarse, honest estimate (R4-13) — absent until it's meaningful.
  const eta = etaText(t)

  return `${verb}${pct}${eta ? ` · ${eta}` : ''}`
}

/**
 * Sidebar transfer indicator (#5, R5-1): running uploads/downloads stay
 * visible from EVERY page. Its own block under a thin separator (user's
 * option A — no section label), each transfer a small card that opens the
 * drive it belongs to.
 */
export default function TransferIndicator() {
  const transfers = useTransfersStore(state => state.transfers)
  const navigate = useNavigate()

  if (transfers.length === 0) return null

  return (
    <div className="px-3 pb-2 space-y-1.5">
      <div className="mx-1 mb-2 h-px" style={{ backgroundColor: 'rgb(var(--sidebar-border) / 0.1)' }} />
      {transfers.map(t => (
        <button
          key={t.id}
          onClick={() => navigate(destination(t))}
          className="w-full flex items-center gap-2 px-2.5 py-2 rounded-lg text-left transition-colors hover:bg-white/5 focus:outline-none focus-visible:ring-1 focus-visible:ring-white/30"
          style={{ backgroundColor: 'rgb(var(--sidebar-accent-bg))' }}
          title={t.phase || t.name}
        >
          {t.status === 'done' ? (
            <Check size={12} className="shrink-0" style={{ color: '#4ade80' }} />
          ) : t.kind === 'upload' ? (
            <ArrowUpFromLine
              size={12}
              className={`shrink-0 ${t.waiting === 'node' ? '' : 'animate-pulse'}`}
              style={{ color: t.waiting ? 'rgb(var(--sidebar-fg-muted))' : 'rgb(var(--accent))' }}
            />
          ) : (
            <ArrowDownToLine size={12} className="shrink-0 animate-pulse" style={{ color: 'rgb(var(--accent))' }} />
          )}
          <span className="flex-1 min-w-0">
            {/* Sidebar tokens (R4-12): the sidebar is dark in both themes. */}
            <span className="block text-[11px] truncate" style={{ color: 'rgb(var(--sidebar-fg))' }}>
              {t.name}
            </span>
            <span className="block text-[10px] tabular-nums" style={{ color: 'rgb(var(--sidebar-fg-muted))' }}>
              {statusText(t)}
            </span>
          </span>
        </button>
      ))}
    </div>
  )
}
