import { useQuery } from '@tanstack/react-query'
import { Download } from 'lucide-react'

import { serverApi } from '../api/server'
import { useSidebar } from './ui/sidebar'

/**
 * Sidebar update notice (test feedback 2026-10-19): the bell rings once per
 * version, and the Settings row is easy to miss — close the bell and there's
 * no way back to the download. This stays at the bottom of the sidebar for as
 * long as a newer Nook exists; it can't be closed, installing the new version
 * removes it. Same `/update` data as the Settings row.
 */
export default function UpdateNotice() {
  const { expanded } = useSidebar()
  const { data: updateInfo } = useQuery({
    queryKey: ['server', 'update'],
    queryFn: serverApi.getUpdateInfo,
    // The server's first check runs a minute after launch, so poll often
    // enough that the notice shows up soon after (the call is local).
    refetchInterval: 10 * 60_000,
    retry: false,
  })

  if (!updateInfo?.updateAvailable || !updateInfo.url) return null

  const label = `Nook ${updateInfo.latest} is available`

  return (
    <div className="px-3 pb-2">
      <a
        href={updateInfo.url}
        target="_blank"
        rel="noreferrer"
        title={!expanded ? `${label} — download` : `You're on ${updateInfo.current}`}
        aria-label={`${label}, download (opens in a new tab)`}
        className={`flex items-center gap-2 rounded-lg transition-colors hover:bg-white/5 focus:outline-none focus-visible:ring-1 focus-visible:ring-white/30 ${
          expanded ? 'px-2.5 py-2' : 'h-10 w-10 mx-auto justify-center relative'
        }`}
        style={{ backgroundColor: 'rgb(var(--sidebar-accent-bg))' }}
      >
        <Download size={expanded ? 12 : 16} className="shrink-0" style={{ color: '#f76808' }} />
        {expanded ? (
          <span className="flex-1 min-w-0">
            {/* Sidebar tokens: the sidebar is dark in both themes. */}
            <span className="block text-[11px] truncate" style={{ color: 'rgb(var(--sidebar-fg))' }}>
              {label}
            </span>
            <span className="block text-[10px] font-semibold" style={{ color: '#f76808' }}>
              Download →
            </span>
          </span>
        ) : (
          <span className="absolute top-1.5 right-1.5 h-2 w-2 rounded-full" style={{ backgroundColor: '#f76808' }} />
        )}
      </a>
    </div>
  )
}
