import { ArrowDownToLine, ArrowUpFromLine, Check } from 'lucide-react'
import { useNavigate } from 'react-router-dom'

import { useTransfersStore } from '../store/transfers'

/**
 * Sidebar transfer indicator (#5): running uploads/downloads stay visible
 * from EVERY page — leaving the Drive page no longer makes an active
 * transfer look like nothing is happening. Clicking goes back to the drive.
 */
export default function TransferIndicator() {
  const transfers = useTransfersStore(state => state.transfers)
  const navigate = useNavigate()

  if (transfers.length === 0) return null

  return (
    <div className="px-3 pb-2 space-y-1">
      {transfers.map(t => (
        <button
          key={t.id}
          onClick={() => navigate('/drive')}
          className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-left transition-colors hover:bg-white/5"
          title={t.phase || t.name}
        >
          {t.status === 'done' ? (
            <Check size={11} className="shrink-0" style={{ color: '#4ade80' }} />
          ) : t.kind === 'upload' ? (
            <ArrowUpFromLine size={11} className="shrink-0 animate-pulse" style={{ color: 'rgb(var(--accent))' }} />
          ) : (
            <ArrowDownToLine size={11} className="shrink-0 animate-pulse" style={{ color: 'rgb(var(--accent))' }} />
          )}
          <span className="flex-1 min-w-0">
            {/* Sidebar tokens (R4-12): the sidebar is dark in both themes, so
                the page's --fg rendered dark-on-dark here. */}
            <span className="block text-[11px] truncate" style={{ color: 'rgb(var(--sidebar-fg))' }}>
              {t.name}
            </span>
            <span className="block text-[10px] tabular-nums" style={{ color: 'rgb(var(--sidebar-fg-muted))' }}>
              {t.status === 'done'
                ? t.kind === 'upload'
                  ? 'Stored'
                  : 'Saved'
                : `${t.kind === 'upload' ? 'Storing' : 'Saving'}${t.pct !== null ? ` · ${t.pct}%` : '…'}`}
            </span>
          </span>
        </button>
      ))}
    </div>
  )
}
