import { AlertTriangle, Bell, CheckCircle2, Clock, Info, UserCheck, UserPlus, Wallet, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'

import { type NookNotification, serverApi } from '../api/server'

/**
 * The bell (#138) — Nook's permanent event feed.
 *
 * Events, not states: banners handle ongoing conditions; this panel records
 * what happened (or is scheduled), newest first, because an app that spends
 * money on the user's behalf owes them a history that can't be un-happened.
 */

const TYPE_ICONS: Record<string, typeof Bell> = {
  'upcoming-charge': Clock,
  'charge-executed': CheckCircle2,
  'charge-blocked': AlertTriangle,
  'chequebook-funded': Wallet,
  'connection-request': UserPlus,
  'connection-accepted': UserCheck,
  info: Info,
}

const TYPE_COLORS: Record<string, string> = {
  'charge-blocked': '#ef4444',
  'upcoming-charge': '#f59e0b',
  'charge-executed': '#4ade80',
}

function relativeTime(ms: number): string {
  const diff = Date.now() - ms

  if (diff < 60_000) return 'just now'

  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`

  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`

  return `${Math.floor(diff / 86_400_000)}d ago`
}

export default function NotificationBell() {
  const [open, setOpen] = useState(false)
  // Snapshot of unread ids at panel-open, so entries keep their unread look
  // while visible even though opening marks them read server-side.
  const [unreadSnapshot, setUnreadSnapshot] = useState<Set<string>>(new Set())
  const ref = useRef<HTMLDivElement>(null)
  const navigate = useNavigate()
  const queryClient = useQueryClient()

  const { data } = useQuery({
    queryKey: ['server', 'notifications'],
    queryFn: serverApi.getNotifications,
    refetchInterval: 30_000,
    retry: false,
  })
  const notifications = data?.notifications ?? []
  const unreadCount = notifications.filter(n => n.readAt === undefined).length

  // Close on outside click (same pattern as WalletDropdown)
  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)

    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  function toggle() {
    if (!open) {
      // Read-on-view: opening the panel is seeing it.
      setUnreadSnapshot(new Set(notifications.filter(n => n.readAt === undefined).map(n => n.id)))

      if (unreadCount > 0) {
        serverApi
          .markNotificationsRead()
          .then(async () => queryClient.invalidateQueries({ queryKey: ['server', 'notifications'] }))
          .catch(() => undefined)
      }
    }
    setOpen(v => !v)
  }

  function openLink(n: NookNotification) {
    setOpen(false)

    if (n.link) navigate(n.link)
  }

  function dismiss(id: string) {
    // Optimistic: the row vanishes on click (#136 principle — instant
    // feedback), the server call follows. On failure, refetch restores the
    // truth. The server keeps dismissed events either way (the Activity
    // list labels transactions from them).
    queryClient.setQueryData<{ notifications: NookNotification[] }>(['server', 'notifications'], old =>
      old ? { notifications: old.notifications.filter(n => n.id !== id) } : old,
    )
    serverApi
      .dismissNotification(id)
      .catch(async () => queryClient.invalidateQueries({ queryKey: ['server', 'notifications'] }))
  }

  return (
    <div ref={ref} className="relative">
      <button
        onClick={toggle}
        aria-label={unreadCount > 0 ? `Notifications (${unreadCount} unread)` : 'Notifications'}
        className="relative flex items-center justify-center w-8 h-8 rounded-full transition-colors hover:bg-white/5"
        style={{ color: 'rgb(var(--fg-muted))' }}
      >
        <Bell size={16} />
        {unreadCount > 0 && (
          <span
            className="absolute -top-0.5 -right-0.5 min-w-[16px] h-4 px-1 rounded-full text-[10px] font-semibold flex items-center justify-center"
            style={{ backgroundColor: '#ef4444', color: 'white' }}
          >
            {unreadCount > 9 ? '9+' : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div
          className="absolute right-0 top-full mt-1 rounded-lg border z-50 w-96 max-h-[420px] overflow-y-auto"
          style={{ backgroundColor: 'rgb(var(--bg-surface))', borderColor: 'rgb(var(--border))' }}
        >
          {notifications.length === 0 ? (
            <p className="px-4 py-6 text-xs text-center" style={{ color: 'rgb(var(--fg-muted))' }}>
              Nothing yet — events like automatic drive extensions will show up here.
            </p>
          ) : (
            notifications.map(n => {
              const Icon = TYPE_ICONS[n.type] ?? Info
              const color = TYPE_COLORS[n.type] ?? 'rgb(var(--fg-muted))'
              const wasUnread = unreadSnapshot.has(n.id) || n.readAt === undefined

              return (
                <div
                  key={n.id}
                  onClick={() => openLink(n)}
                  className={`flex items-start gap-2.5 w-full px-4 py-3 text-left border-b last:border-b-0 transition-colors hover:bg-white/5 ${
                    n.link ? 'cursor-pointer' : ''
                  }`}
                  style={{ borderColor: 'rgb(var(--border))', opacity: wasUnread ? 1 : 0.65 }}
                >
                  <Icon size={14} className="shrink-0 mt-0.5" style={{ color }} />
                  <span className="min-w-0 flex-1">
                    <span className="block text-xs font-medium" style={{ color: 'rgb(var(--fg))' }}>
                      {n.title}
                    </span>
                    <span className="block text-[11px] mt-0.5" style={{ color: 'rgb(var(--fg-muted))' }}>
                      {n.body}
                    </span>
                    <span className="block text-[10px] mt-1" style={{ color: 'rgb(var(--fg-muted))' }}>
                      {relativeTime(n.createdAt)}
                      {n.link && (
                        <>
                          {' · '}
                          <button
                            onClick={e => {
                              e.stopPropagation()
                              openLink(n)
                            }}
                            className="hover:underline font-medium"
                            style={{ color: 'rgb(var(--accent))' }}
                          >
                            {n.link.startsWith('/drive')
                              ? 'View drive →'
                              : n.link.startsWith('/account')
                                ? 'Open wallet →'
                                : 'View →'}
                          </button>
                        </>
                      )}
                    </span>
                  </span>
                  <button
                    onClick={e => {
                      e.stopPropagation()
                      dismiss(n.id)
                    }}
                    aria-label="Dismiss notification"
                    className="shrink-0 p-1 -m-1 mt-0 rounded transition-colors hover:bg-white/10"
                    style={{ color: 'rgb(var(--fg-muted))' }}
                  >
                    <X size={12} />
                  </button>
                </div>
              )
            })
          )}
        </div>
      )}
    </div>
  )
}
