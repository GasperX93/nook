import {
  AlertTriangle,
  Contact,
  Download,
  Globe,
  HardDrive,
  Mail,
  RefreshCw,
  Settings,
  Terminal,
  Wallet,
  X,
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Outlet, useLocation, useNavigate } from 'react-router-dom'
import { weiToDai } from '../api/bee'
import { resumePendingPropagation } from '../store/transfers'
import TransferIndicator from './TransferIndicator'
import {
  useReclaimableDrives,
  useBeeHealth,
  usePeers,
  useRestart,
  useStamps,
  useStatus,
  useWallet,
} from '../api/queries'
import { serverApi } from '../api/server'
import { useDerivedKey } from '../hooks/useDerivedKey'
import { useAutoPublish } from '../hooks/useAutoPublish'
import { useInboxPolling } from '../hooks/useInboxPolling'
import { isSystemStamp, pickMessagingStamp } from '../lib/system-stamp'
import { useOutboxDrain } from '../hooks/useOutboxDrain'
import { hasKnownIdentity, hasLegacyIdentityPendingMove } from '../notify/active-identity'
import { primeCricketAudio } from '../lib/cricket'
import { loadReadCursors, loadThreads, totalUnread } from '../notify/messages'
import { loadInvitations, pendingInvitations } from '../notify/invitations'
import { loadContacts } from '../notify/storage'
import { useRegistryPolling } from '../hooks/useRegistryPolling'
import { useAppStore } from '../store/app'
import NotificationBell from './NotificationBell'
import SwarmIdChip from './SwarmIdChip'
import SwarmIdDialog from './SwarmIdDialog'
import Onboarding from './Onboarding'
import {
  Sidebar,
  SidebarFooter,
  SidebarHeader,
  SidebarMenuItem,
  SidebarProvider,
  SidebarSection,
  SidebarSectionLabel,
  SidebarSeparator,
  SidebarSpacer,
  SidebarTrigger,
} from './ui/sidebar'

const storageNavItems = [
  { to: '/drive', icon: HardDrive, label: 'Drive' },
  { to: '/access', icon: Download, label: 'Access on Swarm' },
]

const youNavItems = [
  { to: '/account', icon: Wallet, label: 'Account' },
  { to: '/contacts', icon: Contact, label: 'Contacts' },
]

const settingsNavItem = { to: '/settings', icon: Settings, label: 'Settings' }

const MOVE_NOTICE_DISMISSED_KEY = 'nook-swarm-id-move-notice-dismissed'

const appNavItems = [{ to: '/apps/website-publisher', icon: Globe, label: 'Publish website' }]

export default function Layout() {
  const { isError: beeOffline, isPending: beeChecking, isSuccess: beeOnline } = useBeeHealth()
  const { data: peers } = usePeers()
  const { data: status } = useStatus()
  const restartBee = useRestart()
  const { data: stamps, isSuccess: stampsLoaded } = useStamps()
  const { data: reclaimableForPick } = useReclaimableDrives()
  // No network space AT ALL in light mode → identity & messages are dead and
  // nothing on screen says why (fresh-install finding). Ongoing state → banner.
  const noUsableMessagingSpace =
    status?.mode === 'light' &&
    stampsLoaded &&
    pickMessagingStamp(stamps, new Set((reclaimableForPick ?? []).map(d => d.batchId))) === null
  // The reserve was just bought but Bee hasn't confirmed it usable yet
  // (~2 min of blocks). Asking for money that's already spent contradicts
  // the "reserved space set aside" bell — show a neutral settling state
  // instead of the amber funding ask (test-run finding #1).
  const reserveSettingUp = noUsableMessagingSpace && (stamps ?? []).some(s => isSystemStamp(s) && !s.usable)
  const noMessagingSpace = noUsableMessagingSpace && !reserveSettingUp
  const { data: walletForReserve } = useWallet()
  // Funds present for the reserve (#13, reworked per round-3 feedback): the
  // purchase is AUTOMATIC — no button, no machinery states. The UI just
  // nudges the server check immediately (instead of its next 60s tick) and
  // shows one calm informational banner until the reserve is usable. Rough
  // client-side gate (~2 xBZZ); the endpoint re-checks every guard.
  const fundsReadyForReserve =
    noMessagingSpace && walletForReserve !== undefined && BigInt(walletForReserve.bzzBalance) >= 20000000000000000n
  const reserveNudged = useRef(false)

  useEffect(() => {
    if (!fundsReadyForReserve || reserveNudged.current) return
    reserveNudged.current = true
    // Fire-and-forget: the server monitor is the backstop either way.
    serverApi.createSystemStamp().catch(() => undefined)
  }, [fundsReadyForReserve])
  // One blue state from "funds arrived" through "bought, confirming":
  const reserveInProgress = reserveSettingUp || fundsReadyForReserve
  const { data: wallet, isSuccess: walletLoaded } = useWallet()
  const { devMode, onboardingCompleted, setOnboardingCompleted } = useAppStore()
  const navigate = useNavigate()
  const location = useLocation()
  // NOTE: Nook does NOT force the wallet to Gnosis globally. Only on-chain
  // notifications (registry.sendNotification) require Gnosis, and those call
  // sites switch just-in-time. Forcing Gnosis here fought the top-up multichain
  // widget (which moves the wallet to other chains for cross-swaps) and the ENS
  // flow (which needs mainnet) — see M10.
  const pageTitles: Record<string, string> = {
    '/drive': 'Drive',
    '/account': 'Account',
    '/contacts': 'Contacts',
    '/access': 'Access on Swarm',
    '/settings': 'Settings',
    '/dev': 'Dev mode',
    '/apps/messages': 'Messages',
    '/apps/website-publisher': 'Publish website',
  }
  const pageTitle = pageTitles[location.pathname] ?? ''

  const youItems = devMode ? [...youNavItems, { to: '/dev', icon: Terminal, label: 'Dev mode' }] : youNavItems

  // Background inbox polling — keeps unread badge fresh whether or not the
  // Messages page is mounted. Side-effect hook; writes to localStorage threads.
  useInboxPolling()
  // Completes 'make me findable' once signer + reserved space coexist (#130/#131)
  useAutoPublish()
  // Background on-chain notification polling — surfaces wake-up pings from
  // senders who aren't yet in our contact list (see #62/#63).
  useRegistryPolling()
  // Persistent-outbox drain (#117) — delivers sends left behind by a quit,
  // and keeps retrying failed ones, whichever page is open.
  useOutboxDrain()

  // Re-attach to propagations interrupted by a quit — tags live on the Bee
  // node, so an unfinished network push resumes visibly (#5).
  useEffect(() => {
    resumePendingPropagation()
  }, [])

  // Unlock notification audio on the first user gesture so a background chirp
  // (e.g. an incoming invitation) isn't silently blocked by autoplay policy.
  useEffect(() => {
    primeCricketAudio()
  }, [])

  // Unread-message badge on the Contacts nav item. Polls localStorage every 2s;
  // also recomputes when the route changes so opening Contacts clears the badge.
  const [unreadCount, setUnreadCount] = useState(0)

  useEffect(() => {
    const recompute = () => {
      // Badge = unread thread messages + pending invitations from senders not
      // yet in contacts. Without the invitation count, a first-contact invite
      // gives no signal anywhere and looks like it "never arrived."
      const known = new Set(loadContacts().map(c => c.id.toLowerCase()))
      const inviteCount = pendingInvitations(loadInvitations()).filter(i => !known.has(i.senderAddr)).length

      setUnreadCount(totalUnread(loadThreads(), loadReadCursors()) + inviteCount)
    }
    recompute()
    const id = setInterval(recompute, 2000)

    return () => clearInterval(id)
  }, [location.pathname])

  // Track whether Bee has connected at least once this session.
  // Before that we show a friendly "starting" indicator instead of an error.
  const hasEverBeenOnline = useRef(false)

  if (beeOnline) hasEverBeenOnline.current = true

  const showStarting = !beeOnline && !hasEverBeenOnline.current
  const showDown = beeOffline && !beeChecking && hasEverBeenOnline.current
  const noFunds = walletLoaded && wallet && Number(weiToDai(wallet.nativeTokenBalance)) === 0
  const showFundingWarning = status?.mode === 'ultra-light' || (beeOnline && noFunds)

  // Messages-paused warning (#65): the derived key is session-only, so after
  // an app/browser restart the inbox silently stops polling — contacts and
  // threads are unreadable without the key, so the UI shows NOTHING and
  // arriving messages look lost. The un-namespaced last-identity marker is
  // the one signal that there is an inbox worth unlocking; only users who
  // have actually used messaging ever see this.
  const { signer: derivedSigner, signIn, deriving } = useDerivedKey()
  const showMessagesPaused = !derivedSigner && hasKnownIdentity()

  // Swarm ID transition (#21): a pre-0.7 wallet-derived identity existed and
  // nobody has signed in with Swarm ID yet. Replaces the paused banner until
  // the user signs in or closes it (closing falls back to the paused banner).
  const [moveNoticeDismissed, setMoveNoticeDismissed] = useState(() => {
    try {
      return localStorage.getItem(MOVE_NOTICE_DISMISSED_KEY) !== null
    } catch {
      return false
    }
  })
  const showMoveNotice = !derivedSigner && !moveNoticeDismissed && hasLegacyIdentityPendingMove()

  // Auto-complete onboarding for existing users upgrading from v0.2.0 (they never had the flag).
  // Once stamps or wallet data loads and shows existing activity, mark onboarding done.
  // Existing users (they own stamps) never get re-onboarded — unless the
  // debug step-lock is set, which must keep the preview on screen.
  if (
    !onboardingCompleted &&
    stampsLoaded &&
    stamps &&
    stamps.length > 0 &&
    !localStorage.getItem('nook:onboarding-step')
  ) {
    setOnboardingCompleted()
  }

  if (!onboardingCompleted && walletLoaded && wallet && Number(weiToDai(wallet.nativeTokenBalance)) > 0) {
    setOnboardingCompleted()
  }

  const peerCount = peers?.connections ?? 0
  const isSyncing = beeOnline && (peerCount === 0 || !stampsLoaded)

  // Returning users: show startup overlay on app load, dismiss once node is fully ready.
  // Wait for peers + stamps so the status dot is green when the overlay lifts.
  const [startupDone, setStartupDone] = useState(false)
  // Session-dismiss for the auto-extend failure banner: it can be put away,
  // but a blocked extension is a countdown — a NEW failure (different drives
  // or reason) or an app restart brings it back. Keyed on the failure set.
  const [dismissedFailureKey, setDismissedFailureKey] = useState<string | null>(null)
  const failureKey = (status?.autoExtendFailures ?? []).map(f => `${f.batchId}:${f.reason}`).join('|')

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
    <SidebarProvider>
      <div className="flex h-screen overflow-hidden" style={{ backgroundColor: 'rgb(var(--bg))' }}>
        {/* Sidebar */}
        <Sidebar>
          <SidebarHeader>
            <span className="text-[10px] font-bold uppercase tracking-widest mb-2 text-sidebar-foreground">Nook</span>
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
          </SidebarHeader>

          <SidebarSeparator />

          <SidebarSection>
            {storageNavItems.map(({ to, icon, label }) => (
              <SidebarMenuItem
                key={to}
                to={to}
                icon={icon}
                label={label}
                onClick={to === '/drive' ? () => navigate(to, { state: { ts: Date.now() } }) : undefined}
              />
            ))}
          </SidebarSection>

          <SidebarSeparator />

          <SidebarSection>
            {youItems.map(({ to, icon, label }) => (
              <SidebarMenuItem
                key={to}
                to={to}
                icon={icon}
                label={label}
                badge={to === '/contacts' ? unreadCount : undefined}
              />
            ))}
          </SidebarSection>

          <SidebarSeparator />
          <SidebarSectionLabel>Apps</SidebarSectionLabel>
          <SidebarSection>
            {appNavItems.map(({ to, icon, label }) => (
              <SidebarMenuItem
                key={to}
                to={to}
                icon={icon}
                label={label}
                onClick={() => navigate(to, { state: { ts: Date.now() } })}
              />
            ))}
          </SidebarSection>

          <SidebarSpacer />
          {/* Active uploads/downloads — visible from every page (#5) */}
          <TransferIndicator />
          <SidebarSeparator />
          <SidebarFooter>
            <SidebarSection>
              <SidebarMenuItem to={settingsNavItem.to} icon={settingsNavItem.icon} label={settingsNavItem.label} />
            </SidebarSection>
            <div className="pt-2">
              <SidebarTrigger />
            </div>
          </SidebarFooter>
        </Sidebar>

        {/* Main content */}
        <main className="flex-1 overflow-auto flex flex-col">
          {/* Top bar — page title + wallet connect */}
          <div className="flex items-center justify-between px-6 shrink-0 relative" style={{ height: 52 }}>
            <h1 className="text-sm font-semibold uppercase tracking-widest" style={{ color: 'rgb(var(--fg-muted))' }}>
              {pageTitle}
            </h1>
            <div className="flex items-center gap-2">
              <NotificationBell />
              {/* permanently mounted SDK host (see SwarmIdDialog) */}
              <SwarmIdDialog />
              {/* identity lives in Swarm ID; wallets appear only in payment flows */}
              <SwarmIdChip />
            </div>
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

          {/* Crash loop — the supervisor gave up restarting Bee (#94) */}
          {status?.crashLoop && !showOnboarding && (
            <div
              className="flex items-center gap-2 px-4 py-2.5 text-xs shrink-0"
              style={{ backgroundColor: 'rgba(239,68,68,0.1)', borderBottom: '1px solid rgba(239,68,68,0.2)' }}
            >
              <AlertTriangle size={13} className="shrink-0" style={{ color: '#ef4444' }} />
              <span style={{ color: '#ef4444' }}>
                Bee keeps crashing — automatic restarts paused.{' '}
                <button
                  onClick={() => navigate('/logs')}
                  className="underline font-semibold"
                  style={{ color: '#ef4444' }}
                >
                  View logs
                </button>{' '}
                ·{' '}
                <button
                  onClick={() => restartBee.mutate()}
                  className="underline font-semibold"
                  style={{ color: '#ef4444' }}
                >
                  Try again
                </button>
              </span>
            </div>
          )}

          {/* Bee down — only shown after it was previously online */}
          {showDown && !status?.crashLoop && !showOnboarding && (
            <div
              className="flex items-center gap-2 px-4 py-2.5 text-xs shrink-0"
              style={{ backgroundColor: 'rgba(239,68,68,0.1)', borderBottom: '1px solid rgba(239,68,68,0.2)' }}
            >
              <AlertTriangle size={13} className="shrink-0" style={{ color: '#ef4444' }} />
              <span style={{ color: '#ef4444' }}>
                Bee node is not running.{' '}
                <button
                  onClick={() => navigate('/logs')}
                  className="underline font-semibold"
                  style={{ color: '#ef4444' }}
                >
                  View logs
                </button>
              </span>
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
                  onClick={() => navigate('/account?tab=wallet')}
                  className="underline font-semibold"
                  style={{ color: 'rgb(var(--accent))' }}
                >
                  Go to Wallet →
                </button>
              </span>
            </div>
          )}

          {/* Auto-extend failure (#129) — a drive is on a countdown and the
              automatic extension couldn't run. Loud on purpose. */}
          {(status?.autoExtendFailures?.length ?? 0) > 0 && !showOnboarding && dismissedFailureKey !== failureKey && (
            <div
              className="flex items-center gap-2.5 px-4 py-2.5 text-xs shrink-0"
              style={{ backgroundColor: 'rgba(239,68,68,0.08)', borderBottom: '1px solid rgba(239,68,68,0.2)' }}
            >
              <AlertTriangle size={12} className="shrink-0" style={{ color: '#ef4444' }} />
              <span style={{ color: 'rgb(var(--fg))' }}>
                {(() => {
                  const failure = status!.autoExtendFailures![0]
                  const label =
                    stamps?.find(s => s.batchID.toLowerCase() === failure.batchId.toLowerCase())?.label ||
                    `${failure.batchId.slice(0, 8)}…`
                  const extra =
                    status!.autoExtendFailures!.length > 1 ? ` (+${status!.autoExtendFailures!.length - 1} more)` : ''

                  return `Couldn't extend "${label}"${extra}: ${failure.reason} `
                })()}
                <button
                  onClick={() => navigate('/account?tab=wallet')}
                  className="underline font-semibold"
                  style={{ color: '#ef4444' }}
                >
                  Open wallet →
                </button>
              </span>
              <button
                onClick={() => setDismissedFailureKey(failureKey)}
                aria-label="Dismiss for now"
                title="Hide until restart or a new failure"
                className="ml-auto shrink-0 p-1 -m-1 rounded transition-colors hover:bg-white/10"
                style={{ color: 'rgb(var(--fg-muted))' }}
              >
                <X size={12} />
              </button>
            </div>
          )}

          {/* Messages paused — identity not derived this session (#65) */}
          {/* No reserved space, light mode (#130) — the money-shaped unlock,
              said in user terms with the action attached. */}
          {noMessagingSpace && !fundsReadyForReserve && !showOnboarding && (
            <div
              className="flex items-center gap-2.5 px-4 py-2.5 text-xs shrink-0"
              style={{ backgroundColor: 'rgba(245,158,11,0.08)', borderBottom: '1px solid rgba(245,158,11,0.25)' }}
            >
              <AlertTriangle size={12} className="shrink-0" style={{ color: '#f59e0b' }} />
              <span style={{ color: 'rgb(var(--fg))' }}>
                Messages and your identity need a small reserved space — add about 3 xBZZ and Nook sets it up
                automatically within a few minutes.{' '}
                <button
                  onClick={() => navigate('/account?tab=wallet')}
                  className="underline font-semibold"
                  style={{ color: '#f59e0b' }}
                >
                  Open wallet →
                </button>
              </span>
            </div>
          )}

          {/* Funds present → bought → confirming: one calm automatic state,
              closed by the "Reserved space…" bell (round-3 wording, user-
              approved — no button, no machinery). */}
          {reserveInProgress && !showOnboarding && (
            <div
              className="flex items-center gap-2.5 px-4 py-2.5 text-xs shrink-0"
              style={{ backgroundColor: 'rgba(96,165,250,0.08)', borderBottom: '1px solid rgba(96,165,250,0.2)' }}
            >
              <RefreshCw size={12} className="animate-spin shrink-0" style={{ color: '#60a5fa' }} />
              <span style={{ color: 'rgb(var(--fg))' }}>
                Setting up your reserved space for messages &amp; identity — this happens automatically. You'll get a
                notification when it's ready.
              </span>
            </div>
          )}

          {showMoveNotice && !showOnboarding && (
            <div
              className="flex items-start gap-2.5 px-4 py-2.5 text-xs shrink-0"
              style={{ backgroundColor: 'rgba(96,165,250,0.08)', borderBottom: '1px solid rgba(96,165,250,0.2)' }}
            >
              <Mail size={12} className="shrink-0 mt-0.5" style={{ color: '#60a5fa' }} />
              <div className="flex-1 space-y-2" style={{ color: 'rgb(var(--fg))' }}>
                <p>
                  <span className="font-semibold">Messaging now uses Swarm ID.</span> Your drives, files and funds are
                  untouched. Sign in to get your new Nook address, then share it with your contacts again — your old
                  address stops receiving messages.
                </p>
                <button
                  onClick={async () => signIn()}
                  disabled={deriving}
                  className="px-3 py-1.5 rounded-md text-xs font-semibold disabled:opacity-60"
                  style={{ backgroundColor: 'rgb(var(--accent))', color: 'rgb(var(--primary-foreground))' }}
                >
                  {deriving ? 'Signing in…' : 'Sign in with Swarm ID'}
                </button>
              </div>
              <button
                onClick={() => {
                  try {
                    localStorage.setItem(MOVE_NOTICE_DISMISSED_KEY, '1')
                  } catch {
                    // best-effort
                  }
                  setMoveNoticeDismissed(true)
                }}
                className="shrink-0 p-0.5 hover:opacity-60"
                aria-label="Dismiss"
              >
                <X size={12} style={{ color: 'rgb(var(--fg-muted))' }} />
              </button>
            </div>
          )}

          {showMessagesPaused && !showMoveNotice && !showOnboarding && (
            <div
              className="flex items-center gap-2.5 px-4 py-2.5 text-xs shrink-0"
              style={{ backgroundColor: 'rgba(96,165,250,0.08)', borderBottom: '1px solid rgba(96,165,250,0.2)' }}
            >
              <Mail size={12} className="shrink-0" style={{ color: '#60a5fa' }} />
              <span style={{ color: 'rgb(var(--fg))' }}>To use Messages, sign in with Swarm ID (top right).</span>
            </div>
          )}

          <div className="flex-1 overflow-auto flex flex-col">
            {showOnboarding ? <Onboarding skipReady={onboardingCompleted} /> : <Outlet />}
          </div>
        </main>
      </div>
    </SidebarProvider>
  )
}
