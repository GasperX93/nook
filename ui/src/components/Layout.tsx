import { AlertTriangle, HardDrive, RefreshCw, Settings, Terminal, Upload, User } from 'lucide-react'
import { useRef } from 'react'
import { NavLink, Outlet } from 'react-router-dom'
import { useBeeHealth } from '../api/queries'
import { useAppStore } from '../store/app'

const baseNavItems = [
  { to: '/publish', icon: Upload, label: 'Publish' },
  { to: '/drive', icon: HardDrive, label: 'Drive' },
  { to: '/account', icon: User, label: 'Account' },
  { to: '/settings', icon: Settings, label: 'Settings' },
]

export default function Layout() {
  const { isError: beeOffline, isPending: beeChecking, isSuccess: beeOnline } = useBeeHealth()
  const { devMode } = useAppStore()

  const navItems = devMode ? [...baseNavItems, { to: '/dev', icon: Terminal, label: 'Developer' }] : baseNavItems

  // Track whether Bee has connected at least once this session.
  // Before that we show a friendly "starting" indicator instead of an error.
  const hasEverBeenOnline = useRef(false)

  if (beeOnline) hasEverBeenOnline.current = true

  const showStarting = !beeOnline && !hasEverBeenOnline.current
  const showDown = beeOffline && !beeChecking && hasEverBeenOnline.current

  const dotColor = beeChecking ? 'rgb(var(--border))' : beeOnline ? '#4ade80' : '#ef4444'
  const dotLabel = beeChecking ? '···' : beeOnline ? 'live' : 'off'

  return (
    <div className="flex h-screen overflow-hidden" style={{ backgroundColor: 'rgb(var(--bg))' }}>
      {/* Sidebar */}
      <aside
        className="w-14 flex flex-col items-center pt-5 pb-4 shrink-0 border-r"
        style={{ backgroundColor: 'rgb(var(--bg-surface))' }}
      >
        {/* Wordmark */}
        <span className="text-[10px] font-bold uppercase tracking-widest mb-4" style={{ color: 'rgb(var(--fg))' }}>
          Nook
        </span>

        {/* Node status dot */}
        <div className="flex flex-col items-center gap-1.5 mb-5" title={`Bee node: ${dotLabel}`}>
          <div
            className="w-2 h-2 rounded-full transition-colors"
            style={{ backgroundColor: dotColor, boxShadow: beeOnline ? `0 0 6px ${dotColor}` : 'none' }}
          />
          <span className="text-[8px] uppercase tracking-widest font-semibold" style={{ color: dotColor }}>
            {dotLabel}
          </span>
        </div>

        <div className="w-6 border-t mb-3" />

        {/* Nav */}
        <nav className="flex flex-col gap-1 flex-1">
          {navItems.map(({ to, icon: Icon, label }) => (
            <NavLink
              key={to}
              to={to}
              title={label}
              className={({ isActive }) =>
                [
                  'flex items-center justify-center w-9 h-9 rounded-lg transition-colors',
                  isActive ? 'text-white' : 'text-[rgb(var(--fg-muted))] hover:text-[rgb(var(--fg))]',
                ].join(' ')
              }
              style={({ isActive }) => (isActive ? { backgroundColor: 'rgb(var(--accent))' } : {})}
            >
              <Icon size={16} />
            </NavLink>
          ))}
        </nav>
      </aside>

      {/* Main content */}
      <main className="flex-1 overflow-auto flex flex-col">
        {/* Starting up — friendly indicator */}
        {showStarting && (
          <div
            className="flex items-center gap-2.5 px-4 py-2.5 text-xs shrink-0"
            style={{ backgroundColor: 'rgba(247,104,8,0.08)', borderBottom: '1px solid rgba(247,104,8,0.15)' }}
          >
            <RefreshCw size={12} className="animate-spin shrink-0" style={{ color: 'rgb(var(--accent))' }} />
            <span style={{ color: 'rgb(var(--accent))' }}>Starting Bee node and connecting to the network…</span>
          </div>
        )}

        {/* Bee down — only shown after it was previously online */}
        {showDown && (
          <div
            className="flex items-center gap-2 px-4 py-2.5 text-xs shrink-0"
            style={{ backgroundColor: 'rgba(239,68,68,0.1)', borderBottom: '1px solid rgba(239,68,68,0.2)' }}
          >
            <AlertTriangle size={13} className="shrink-0" style={{ color: '#ef4444' }} />
            <span style={{ color: '#ef4444' }}>Bee node is not running. Check the Logs tab for details.</span>
          </div>
        )}

        <div className="flex-1 overflow-auto">
          <Outlet />
        </div>
      </main>
    </div>
  )
}
