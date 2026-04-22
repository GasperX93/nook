import { ConnectButton } from '@rainbow-me/rainbowkit'
import {
  AlertTriangle,
  Copy,
  Globe,
  HardDrive,
  LogOut,
  RefreshCw,
  Settings,
  Terminal,
  User,
  Users,
  Wallet,
} from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import { useAccount, useDisconnect, useSwitchChain } from 'wagmi'
import { gnosis } from 'wagmi/chains'
import { weiToDai } from '../api/bee'
import { useBeeHealth, usePeers, useStamps, useStatus, useWallet } from '../api/queries'
import { useAppStore } from '../store/app'
import Onboarding from './Onboarding'

const mainNavItems = [
  { to: '/drive', icon: HardDrive, label: 'Drive' },
  { to: '/account', icon: User, label: 'Account' },
  { to: '/contacts', icon: Users, label: 'Contacts' },
]

const settingsNavItem = { to: '/settings', icon: Settings, label: 'Settings' }

const appNavItems = [{ to: '/apps/website-publisher', icon: Globe, label: 'Publish', sublabel: 'website' }]

function WalletDropdown({ displayName, address, avatar }: { displayName: string; address: string; avatar?: string }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const { disconnect } = useDisconnect()

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(address)
    setOpen(false)
  }, [address])

  const handleDisconnect = useCallback(() => {
    disconnect()
    setOpen(false)
  }, [disconnect])

  // Close on outside click
  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)

    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="nook-wallet-btn connected flex items-center gap-2 px-3 py-1.5 rounded-full text-xs transition-colors border"
      >
        {avatar ? (
          <img src={avatar} alt="" className="w-4 h-4 rounded-full" />
        ) : (
          <div className="w-4 h-4 rounded-full" style={{ backgroundColor: 'rgb(var(--fg-muted))' }} />
        )}
        {displayName}
      </button>
      {open && (
        <div
          className="absolute right-0 top-full mt-1 rounded-lg border py-1 z-50 min-w-[180px]"
          style={{ backgroundColor: 'rgb(var(--bg-surface))', borderColor: 'rgb(var(--border))' }}
        >
          <button
            onClick={handleCopy}
            className="flex items-center gap-2.5 w-full px-3 py-2 text-xs transition-colors hover:bg-white/5"
            style={{ color: 'rgb(var(--fg))' }}
          >
            <Copy size={13} style={{ color: 'rgb(var(--fg-muted))' }} />
            {address.slice(0, 6)}...{address.slice(-4)}
          </button>
          <button
            onClick={handleDisconnect}
            className="flex items-center gap-2.5 w-full px-3 py-2 text-xs transition-colors hover:bg-white/5"
            style={{ color: '#ef4444' }}
          >
            <LogOut size={13} />
            Disconnect
          </button>
        </div>
      )}
    </div>
  )
}

export default function Layout() {
  const { isError: beeOffline, isPending: beeChecking, isSuccess: beeOnline } = useBeeHealth()
  const { data: peers } = usePeers()
  const { data: status } = useStatus()
  const { data: stamps, isSuccess: stampsLoaded } = useStamps()
  const { data: wallet, isSuccess: walletLoaded } = useWallet()
  const { devMode, onboardingCompleted, setOnboardingCompleted } = useAppStore()
  const navigate = useNavigate()
  const location = useLocation()
  const { chain } = useAccount()
  const { switchChain } = useSwitchChain()

  // Auto-switch to Gnosis Chain — Nook only operates on Gnosis
  useEffect(() => {
    if (chain && chain.id !== gnosis.id && switchChain) {
      switchChain({ chainId: gnosis.id })
    }
  }, [chain, switchChain])

  const pageTitles: Record<string, string> = {
    '/drive': 'Drive',
    '/account': 'Account',
    '/contacts': 'Contacts',
    '/settings': 'Settings',
    '/dev': 'Dev mode',
    '/apps/website-publisher': 'Publish website',
  }
  const pageTitle = pageTitles[location.pathname] ?? ''

  const navItems = devMode ? [...mainNavItems, { to: '/dev', icon: Terminal, label: 'Dev mode' }] : mainNavItems

  // Track whether Bee has connected at least once this session.
  // Before that we show a friendly "starting" indicator instead of an error.
  const hasEverBeenOnline = useRef(false)

  if (beeOnline) hasEverBeenOnline.current = true

  const showStarting = !beeOnline && !hasEverBeenOnline.current
  const showDown = beeOffline && !beeChecking && hasEverBeenOnline.current
  const noFunds = walletLoaded && wallet && Number(weiToDai(wallet.nativeTokenBalance)) === 0
  const showFundingWarning = status?.mode === 'ultra-light' || (beeOnline && noFunds)

  // Auto-complete onboarding for existing users upgrading from v0.2.0 (they never had the flag).
  // Once stamps or wallet data loads and shows existing activity, mark onboarding done.
  if (!onboardingCompleted && stampsLoaded && stamps && stamps.length > 0) setOnboardingCompleted()

  if (!onboardingCompleted && walletLoaded && wallet && Number(weiToDai(wallet.nativeTokenBalance)) > 0) {
    setOnboardingCompleted()
  }

  const peerCount = peers?.connections ?? 0
  const isSyncing = beeOnline && (peerCount === 0 || !stampsLoaded)

  // Returning users: show startup overlay on app load, dismiss once node is fully ready.
  // Wait for peers + stamps so the status dot is green when the overlay lifts.
  const [startupDone, setStartupDone] = useState(false)

  useEffect(() => {
    if (startupDone || !onboardingCompleted) return

    if (!beeOnline || !stampsLoaded || peerCount === 0) return
    const timer = setTimeout(() => setStartupDone(true), 800)

    return () => clearTimeout(timer)
  }, [beeOnline, stampsLoaded, peerCount, startupDone, onboardingCompleted])

  const showOnboarding = !onboardingCompleted || (onboardingCompleted && !startupDone)

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
        {/* Top bar — page title + wallet connect */}
        <div className="flex items-center justify-between px-6 shrink-0 relative" style={{ height: 52 }}>
          <h1 className="text-sm font-semibold uppercase tracking-widest" style={{ color: 'rgb(var(--fg-muted))' }}>
            {pageTitle}
          </h1>
          <ConnectButton.Custom>
            {({ account, chain, openConnectModal, mounted }) => {
              if (!mounted) return null

              if (!account || !chain) {
                return (
                  <button
                    onClick={openConnectModal}
                    className="nook-wallet-btn flex items-center gap-2 px-3 py-1.5 rounded-full text-xs transition-colors border"
                  >
                    Connect Wallet
                  </button>
                )
              }

              return (
                <WalletDropdown
                  displayName={account.displayName}
                  address={account.address}
                  avatar={account.ensAvatar}
                />
              )
            }}
          </ConnectButton.Custom>
        </div>

        {/* Starting up — friendly indicator */}
        {showStarting && !showOnboarding && (
          <div
            className="flex items-center gap-2.5 px-4 py-2.5 text-xs shrink-0"
            style={{ backgroundColor: 'rgba(247,104,8,0.08)', borderBottom: '1px solid rgba(247,104,8,0.15)' }}
          >
            <RefreshCw size={12} className="animate-spin shrink-0" style={{ color: 'rgb(var(--accent))' }} />
            <span style={{ color: 'rgb(var(--accent))' }}>Starting Bee node and connecting to the network…</span>
          </div>
        )}

        {/* Bee down — only shown after it was previously online */}
        {showDown && !showOnboarding && (
          <div
            className="flex items-center gap-2 px-4 py-2.5 text-xs shrink-0"
            style={{ backgroundColor: 'rgba(239,68,68,0.1)', borderBottom: '1px solid rgba(239,68,68,0.2)' }}
          >
            <AlertTriangle size={13} className="shrink-0" style={{ color: '#ef4444' }} />
            <span style={{ color: '#ef4444' }}>Bee node is not running. Check the Logs tab for details.</span>
          </div>
        )}

        {/* Needs funding — shown when Bee exits because wallet has no xDAI */}
        {showFundingWarning && !showOnboarding && (
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
          {showOnboarding ? <Onboarding skipReady={onboardingCompleted} /> : <Outlet />}
        </div>
      </main>
    </div>
  )
}
