import { AlertTriangle, Globe, HardDrive, RefreshCw, Settings, Terminal, User, Wallet } from 'lucide-react'
import { useRef } from 'react'
import { NavLink, Outlet, useNavigate } from 'react-router-dom'
import { weiToDai } from '../api/bee'
import { useBeeHealth, usePeers, useStamps, useStatus, useWallet } from '../api/queries'
import { useAppStore } from '../store/app'
import Onboarding from './Onboarding'

const mainNavItems = [
  { to: '/drive', icon: HardDrive, label: 'Drive' },
  { to: '/account', icon: User, label: 'Account' },
]

const settingsNavItem = { to: '/settings', icon: Settings, label: 'Settings' }

const appNavItems = [{ to: '/apps/website-publisher', icon: Globe, label: 'Publish', sublabel: 'website' }]

export default function Layout() {
  const { isError: beeOffline, isPending: beeChecking, isSuccess: beeOnline } = useBeeHealth()
  const { data: peers } = usePeers()
  const { data: status } = useStatus()
  const { data: stamps } = useStamps()
  const { data: wallet } = useWallet()
  const { devMode, onboardingCompleted } = useAppStore()
  const navigate = useNavigate()

  const navItems = devMode ? [...mainNavItems, { to: '/dev', icon: Terminal, label: 'Dev mode' }] : mainNavItems

  // Track whether Bee has connected at least once this session.
  // Before that we show a friendly "starting" indicator instead of an error.
  const hasEverBeenOnline = useRef(false)

  if (beeOnline) hasEverBeenOnline.current = true

  // Latch needsFunding so the banner doesn't disappear when Bee restarts.
  // Cleared when wallet gets funded (xDAI > 0).
  const needsFundingLatch = useRef(false)

  if (status?.needsFunding) needsFundingLatch.current = true

  if (wallet && Number(weiToDai(wallet.nativeTokenBalance)) > 0) needsFundingLatch.current = false

  const showStarting = !beeOnline && !hasEverBeenOnline.current
  const showDown = beeOffline && !beeChecking && hasEverBeenOnline.current
  const showFundingWarning = needsFundingLatch.current && !beeOnline && !beeChecking

  // Show onboarding for new users: no stamps, no wallet balance, not previously completed.
  // localStorage 'nook:force-onboarding' can override for testing.
  const forceOnboarding = localStorage.getItem('nook:force-onboarding') === 'true'
  const isNewUser =
    forceOnboarding ||
    (!onboardingCompleted &&
      (!stamps || stamps.length === 0) &&
      (!wallet || Number(weiToDai(wallet.nativeTokenBalance)) === 0))

  // Returning users: show sync overlay while stamps endpoint isn't ready (503 during postage sync)
  const stampsReady = stamps !== undefined
  const showSyncOverlay = !isNewUser && beeOnline && !stampsReady

  const peerCount = peers?.connections ?? 0
  const isSyncing = beeOnline && peerCount === 0

  const dotColor = beeChecking ? 'rgb(var(--border))' : isSyncing ? '#f97316' : beeOnline ? '#4ade80' : '#ef4444'
  const dotLabel = beeChecking ? '···' : isSyncing ? 'sync' : beeOnline ? 'live' : 'off'

  return (
    <div className="flex h-screen overflow-hidden" style={{ backgroundColor: 'rgb(var(--bg))' }}>
      {/* Sidebar */}
      <aside
        className="w-16 flex flex-col items-center pt-5 pb-4 shrink-0 border-r gap-1"
        style={{ backgroundColor: 'rgb(var(--bg-surface))' }}
      >
        {/* Wordmark */}
        <span className="text-[10px] font-bold uppercase tracking-widest mb-2" style={{ color: 'rgb(var(--fg))' }}>
          Nook
        </span>

        {/* Node status dot */}
        <div
          className="flex flex-col items-center gap-1 mb-3"
          title={`Bee node: ${dotLabel}${beeOnline ? ` · ${peerCount} peers` : ''}`}
        >
          <div
            className="w-2 h-2 rounded-full transition-colors"
            style={{ backgroundColor: dotColor, boxShadow: beeOnline ? `0 0 6px ${dotColor}` : 'none' }}
          />
          <span className="text-[8px] uppercase tracking-widest font-semibold" style={{ color: dotColor }}>
            {dotLabel}
          </span>
        </div>

        <div className="w-10 mb-2" style={{ borderTop: '1px solid rgba(255,255,255,0.25)' }} />

        {/* Main nav — Drive + Account */}
        <nav className="flex flex-col gap-0.5 w-full px-2">
          {navItems.map(({ to, icon: Icon, label }) => (
            <NavLink
              key={to}
              to={to}
              onClick={to === '/drive' ? () => navigate(to, { state: { ts: Date.now() } }) : undefined}
              className={({ isActive }) =>
                [
                  'flex flex-col items-center gap-0.5 py-2 rounded-lg transition-colors w-full',
                  isActive ? 'text-white' : 'text-[rgb(var(--fg-muted))] hover:text-[rgb(var(--fg))]',
                ].join(' ')
              }
              style={({ isActive }) => (isActive ? { backgroundColor: 'rgba(247,104,8,0.65)' } : {})}
            >
              <Icon size={15} />
              <span className="text-[9px] font-medium leading-none">{label}</span>
            </NavLink>
          ))}
        </nav>

        {/* Apps section */}
        <div className="w-10 my-3" style={{ borderTop: '1px solid rgba(255,255,255,0.25)' }} />
        <span
          className="text-[8px] font-bold uppercase tracking-widest mb-1.5 w-full text-center"
          style={{ color: 'rgb(var(--fg-muted))' }}
        >
          Apps
        </span>
        <nav className="flex flex-col gap-0.5 w-full px-2">
          {appNavItems.map(({ to, icon: Icon, label, sublabel }) => (
            <NavLink
              key={to}
              to={to}
              onClick={() => navigate(to, { state: { ts: Date.now() } })}
              className={({ isActive }) =>
                [
                  'flex flex-col items-center gap-0.5 py-2 rounded-lg transition-colors w-full',
                  isActive ? 'text-white' : 'text-[rgb(var(--fg-muted))] hover:text-[rgb(var(--fg))]',
                ].join(' ')
              }
              style={({ isActive }) => (isActive ? { backgroundColor: 'rgba(247,104,8,0.65)' } : {})}
            >
              <Icon size={15} />
              <span className="text-[9px] font-medium leading-tight text-center">
                {label}
                <br />
                {sublabel}
              </span>
            </NavLink>
          ))}
        </nav>

        {/* Settings pinned to bottom */}
        <div className="flex-1" />
        <div className="w-10 mb-2" style={{ borderTop: '1px solid rgba(255,255,255,0.25)' }} />
        <nav className="w-full px-2">
          <NavLink
            to={settingsNavItem.to}
            className={({ isActive }) =>
              [
                'flex flex-col items-center gap-0.5 py-2 rounded-lg transition-colors w-full',
                isActive ? 'text-white' : 'text-[rgb(var(--fg-muted))] hover:text-[rgb(var(--fg))]',
              ].join(' ')
            }
            style={({ isActive }) => (isActive ? { backgroundColor: 'rgba(247,104,8,0.65)' } : {})}
          >
            <settingsNavItem.icon size={15} />
            <span className="text-[9px] font-medium leading-none">{settingsNavItem.label}</span>
          </NavLink>
        </nav>
      </aside>

      {/* Main content */}
      <main className="flex-1 overflow-auto flex flex-col">
        {/* Starting up — friendly indicator */}
        {showStarting && !isNewUser && (
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

        {/* Needs funding — shown when Bee exits because wallet has no xDAI */}
        {showFundingWarning && !isNewUser && (
          <div
            className="flex items-center gap-2.5 px-4 py-2.5 text-xs shrink-0"
            style={{ backgroundColor: 'rgba(247,104,8,0.08)', borderBottom: '1px solid rgba(247,104,8,0.15)' }}
          >
            <Wallet size={12} className="shrink-0" style={{ color: 'rgb(var(--accent))' }} />
            <span style={{ color: 'rgb(var(--accent))' }}>
              Fund your node wallet to start.{' '}
              <button
                onClick={() => navigate('/account')}
                className="underline font-semibold"
                style={{ color: 'rgb(var(--accent))' }}
              >
                Go to Wallet →
              </button>
            </span>
          </div>
        )}

        <div className="flex-1 overflow-auto flex flex-col">
          {isNewUser ? <Onboarding mode="full" /> : showSyncOverlay ? <Onboarding mode="sync" /> : <Outlet />}
        </div>
      </main>
    </div>
  )
}
