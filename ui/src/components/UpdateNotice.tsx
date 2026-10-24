import { Download, RefreshCw } from 'lucide-react'

import { useAppUpdate } from '../hooks/useAppUpdate'
import { useSidebar } from './ui/sidebar'

const ORANGE = '#f76808'

/**
 * Sidebar update notice (test feedback 2026-10-19/20): the bell rings once per
 * version and is easy to close, so this stays at the bottom of the sidebar for
 * as long as a newer Nook exists. Mac/Windows: an Update button that restarts
 * into the version already downloaded in the background. Elsewhere, or if the
 * download failed: a link to the release.
 */
export default function UpdateNotice() {
  const { expanded } = useSidebar()
  const { info, available, canInstall, stuck, reopen, busy, update } = useAppUpdate()

  if (!info || !available || (!canInstall && !reopen && !info.url)) return null

  const label = info.latest ? `Nook ${info.latest} is available` : 'A new Nook is available'
  let action = 'Download →'

  if (busy) action = 'Updating…'
  else if (canInstall) action = 'Update'
  else if (reopen) action = 'Quit and reopen Nook to finish'
  const title = busy
    ? 'Nook restarts in a moment, then this page reloads.'
    : !expanded
      ? `${label} — ${canInstall ? 'update' : 'download'}`
      : `${stuck ? 'The download seems stuck. Quit and reopen Nook to try again, or download it here. ' : ''}You're on ${info.current}`
  const className = `flex items-center gap-2 rounded-lg text-left transition-colors hover:bg-white/5 focus:outline-none focus-visible:ring-1 focus-visible:ring-white/30 disabled:cursor-default ${
    expanded ? 'w-full px-2.5 py-2' : 'h-10 w-10 mx-auto justify-center relative'
  }`
  const content = (
    <>
      {busy ? (
        <RefreshCw size={expanded ? 12 : 16} className="shrink-0 animate-spin" style={{ color: ORANGE }} />
      ) : (
        <Download size={expanded ? 12 : 16} className="shrink-0" style={{ color: ORANGE }} />
      )}
      {expanded ? (
        <span className="flex-1 min-w-0">
          {/* Sidebar tokens: the sidebar is dark in both themes. */}
          <span className="block text-[11px] truncate" style={{ color: 'rgb(var(--sidebar-fg))' }}>
            {label}
          </span>
          <span className="block text-[10px] font-semibold" style={{ color: ORANGE }}>
            {action}
          </span>
        </span>
      ) : (
        <span className="absolute top-1.5 right-1.5 h-2 w-2 rounded-full" style={{ backgroundColor: ORANGE }} />
      )}
    </>
  )
  const style = { backgroundColor: 'rgb(var(--sidebar-accent-bg))' }

  return (
    <div className="px-3 pb-2">
      {reopen && (
        <div
          title="Nook didn't restart. Quit it from the menu bar (Mac) or tray (Windows) and open it again; the update is ready and finishes then."
          className={className}
          style={style}
        >
          {content}
        </div>
      )}
      {!reopen && canInstall && (
        <button
          type="button"
          onClick={update}
          disabled={busy}
          title={title}
          aria-label={busy ? 'Updating Nook' : `${label}, update now`}
          className={className}
          style={style}
        >
          {content}
        </button>
      )}
      {!reopen && !canInstall && (
        <a
          href={info.url ?? undefined}
          target="_blank"
          rel="noreferrer"
          title={title}
          aria-label={`${label}, download (opens in a new tab)`}
          className={className}
          style={style}
        >
          {content}
        </a>
      )}
    </div>
  )
}
