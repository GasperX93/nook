import { AlertTriangle, FileText, HardDrive, Settings, Upload, Wallet } from 'lucide-react'
import { NavLink, Outlet } from 'react-router-dom'
import { useBeeHealth } from '../api/queries'

const navItems = [
  { to: '/publish', icon: Upload, label: 'Publish' },
  { to: '/drive', icon: HardDrive, label: 'Drive' },
  { to: '/wallet', icon: Wallet, label: 'Wallet' },
  { to: '/settings', icon: Settings, label: 'Settings' },
  { to: '/logs', icon: FileText, label: 'Logs' },
]

export default function Layout() {
  const { isError: beeOffline, isPending: beeChecking, isSuccess: beeOnline } = useBeeHealth()

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
                  isActive
                    ? 'text-white'
                    : 'text-[rgb(var(--fg-muted))] hover:text-[rgb(var(--fg))]',
                ].join(' ')
              }
              style={({ isActive }) =>
                isActive ? { backgroundColor: 'rgb(var(--accent))' } : {}
              }
            >
              <Icon size={16} />
            </NavLink>
          ))}
        </nav>
      </aside>

      {/* Main content */}
      <main className="flex-1 overflow-auto flex flex-col">
        {/* Bee offline banner — only after health check completes */}
        {!beeChecking && beeOffline && (
          <div
            className="flex items-center gap-2 px-4 py-2.5 text-xs shrink-0"
            style={{ backgroundColor: 'rgba(239,68,68,0.1)', borderBottom: '1px solid rgba(239,68,68,0.2)' }}
          >
            <AlertTriangle size={13} className="shrink-0" style={{ color: '#ef4444' }} />
            <span style={{ color: '#ef4444' }}>
              Can't reach Bee node at localhost:1633. Make sure your node is running.
            </span>
          </div>
        )}
        <div className="flex-1 overflow-auto">
          <Outlet />
        </div>
      </main>
    </div>
  )
}
