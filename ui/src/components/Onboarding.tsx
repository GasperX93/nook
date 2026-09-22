import { AlertTriangle, Check, Copy, Loader2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import '@rainbow-me/rainbowkit/styles.css'
import '@upcoming/multichain-widget/styles.css'
import { MultichainWidget } from '@upcoming/multichain-widget'
import { weiToDai } from '../api/bee'
import { api } from '../api/client'
import { useAddresses, useBeeHealth, useRestart, useStamps, useStatus, useWallet } from '../api/queries'
import { useAppStore } from '../store/app'
import { useDerivedKey } from '../hooks/useDerivedKey'
import { WIDGET_THEME } from '../theme'
import { ConnectButton } from '@rainbow-me/rainbowkit'

type Step = 'starting' | 'identity' | 'funding' | 'syncing' | 'ready'

// Identity comes BEFORE funding (post-test feedback 2026-09-21): it's free
// and takes seconds, so it happens while the user is engaged — and the
// funding screen stays a single-purpose screen instead of stacking two jobs.
// The old 'info' step is gone (its funding copy duplicated the funding
// screen word-for-word once identity moved between them); its one unique
// piece — the beta disclaimer — lives on the funding screen now.
const STEPS: Step[] = ['starting', 'identity', 'funding', 'syncing', 'ready']

export default function Onboarding({ skipReady = false }: { skipReady?: boolean }) {
  const navigate = useNavigate()
  const { setOnboardingCompleted } = useAppStore()

  const { isSuccess: beeOnline } = useBeeHealth()
  const { data: status } = useStatus()
  const { isSuccess: stampsReady } = useStamps()
  const { data: wallet, refetch: refetchWallet, isFetching: walletChecking } = useWallet()
  const { data: addresses } = useAddresses()
  const restart = useRestart()

  const [step, setStep] = useState<Step>('starting')
  const [copiedAddr, setCopiedAddr] = useState(false)
  const [giftCode, setGiftCode] = useState('')
  const [redeeming, setRedeeming] = useState(false)
  const [redeemError, setRedeemError] = useState<string | null>(null)
  const [redeemDone, setRedeemDone] = useState(false)

  const address = addresses?.ethereum ?? (status?.address ? `0x${status.address}` : '')
  const hasFunds = wallet ? Number(weiToDai(wallet.nativeTokenBalance)) > 0 : false

  // Debug: lock to a specific step via localStorage (e.g. 'starting', 'syncing', 'funding')
  const lockedStep = localStorage.getItem('nook:onboarding-step') as Step | null

  // Show the "starting" step for at least 3s so the user sees it
  const [startingMinElapsed, setStartingMinElapsed] = useState(false)
  useEffect(() => {
    const timer = setTimeout(() => setStartingMinElapsed(true), 3000)

    return () => clearTimeout(timer)
  }, [])

  // Unified auto-advance logic (disabled when step is locked for testing)
  // starting → identity (manual continue) → funding → syncing → ready
  // Returning users (skipReady): skip identity+funding, go straight to syncing
  useEffect(() => {
    if (lockedStep) return

    if (step !== 'starting' || !startingMinElapsed) return

    if (skipReady && beeOnline) {
      setStep('syncing')

      return
    }

    // Once Bee is online or mode is known, advance to the identity step
    if (status?.mode === 'ultra-light' || beeOnline) setStep('identity')
  }, [step, beeOnline, status?.mode, lockedStep, startingMinElapsed, skipReady])

  useEffect(() => {
    if (!lockedStep && step === 'funding' && hasFunds) setStep('syncing')
  }, [step, hasFunds, lockedStep])

  useEffect(() => {
    if (!lockedStep && step === 'syncing' && stampsReady) {
      if (skipReady) return // Layout handles dismissal for returning users

      if (status?.mode !== 'light') return // Wait for backend to switch to light mode
      setStep('ready')
    }
  }, [step, stampsReady, lockedStep, skipReady, status?.mode])

  // Apply locked step
  useEffect(() => {
    if (lockedStep && STEPS.includes(lockedStep)) setStep(lockedStep)
  }, [lockedStep])

  function copyAddress() {
    navigator.clipboard.writeText(address)
    setCopiedAddr(true)
    setTimeout(() => setCopiedAddr(false), 2000)
  }

  async function redeem() {
    if (!giftCode.trim()) return
    setRedeeming(true)
    setRedeemError(null)
    setRedeemDone(false)
    try {
      await api.redeem(giftCode.trim())
      setRedeemDone(true)
      setGiftCode('')
      setStep('syncing')
    } catch (err) {
      setRedeemError(err instanceof Error ? err.message : 'Redeem failed')
    } finally {
      setRedeeming(false)
    }
  }

  function finish() {
    setOnboardingCompleted()
    navigate('/drive')
  }

  function skip() {
    setOnboardingCompleted()
  }

  const stepIndex = STEPS.indexOf(step)

  return (
    <div className="flex-1 flex flex-col items-center p-8 pt-16 overflow-auto">
      <div className="w-full max-w-lg">
        {/* Step indicator — new users only */}
        {!skipReady && (
          <div className="flex items-center justify-center gap-2 mb-10">
            {STEPS.map((s, i) => (
              <div key={s} className="flex items-center gap-2">
                <div
                  className="w-2 h-2 rounded-full transition-all"
                  style={{
                    backgroundColor: i <= stepIndex ? 'rgb(var(--accent))' : 'rgb(var(--border))',
                    boxShadow: i === stepIndex ? '0 0 8px rgba(247,104,8,0.5)' : 'none',
                  }}
                />
                {i < STEPS.length - 1 && (
                  <div
                    className="w-8 h-px"
                    style={{ backgroundColor: i < stepIndex ? 'rgb(var(--accent))' : 'rgb(var(--border))' }}
                  />
                )}
              </div>
            ))}
          </div>
        )}

        {/* Step 1 — Node starting (or stopped, if user clicked Stop Bee from the tray) */}
        {step === 'starting' && status?.userStopped && (
          <div className="text-center space-y-4">
            <AlertTriangle size={32} className="mx-auto" style={{ color: 'rgb(var(--accent))' }} />
            <h2 className="text-lg font-semibold">Bee node is stopped</h2>
            <p className="text-sm leading-relaxed" style={{ color: 'rgb(var(--fg-muted))' }}>
              You stopped the node from the tray menu. Click below to start it again, or use the tray icon → Start Bee.
            </p>
            <button
              onClick={() => restart.mutate()}
              disabled={restart.isPending}
              className="px-5 py-2 rounded-lg text-sm font-semibold disabled:opacity-40 inline-flex items-center gap-2"
              style={{ backgroundColor: 'rgb(var(--accent))', color: 'rgb(var(--primary-foreground))' }}
            >
              {restart.isPending && <Loader2 size={13} className="animate-spin" />}
              {restart.isPending ? 'Starting…' : 'Start Bee'}
            </button>
          </div>
        )}

        {step === 'starting' && !status?.userStopped && (
          <div className="text-center space-y-4">
            <Loader2 size={32} className="animate-spin mx-auto" style={{ color: 'rgb(var(--accent))' }} />
            <h2 className="text-lg font-semibold">Starting your node</h2>
            <p className="text-sm leading-relaxed" style={{ color: 'rgb(var(--fg-muted))' }}>
              Nook is starting a Bee node on your machine. This connects you to the Swarm decentralized storage network
              — a peer-to-peer system for storing and sharing files.
            </p>
            <p className="text-xs" style={{ color: 'rgb(var(--fg-muted))' }}>
              This usually takes a few seconds.
            </p>
          </div>
        )}

        {/* Step 2 — Identity (own screen; free, fast, before any waiting).
            No consent checkbox (post-test feedback): being findable is the
            point of an identity — the sentence says so, and the opt-out
            toggle lives in Account → Identity. */}
        {step === 'identity' && <OnboardingIdentityStep onContinue={() => setStep('funding')} />}

        {/* Step 4 — Syncing */}
        {step === 'syncing' && (
          <div className="text-center space-y-4">
            <Loader2 size={32} className="animate-spin mx-auto" style={{ color: '#f97316' }} />
            <h2 className="text-lg font-semibold">Connecting to the network</h2>
            <p className="text-sm leading-relaxed" style={{ color: 'rgb(var(--fg-muted))' }}>
              Your node is syncing with the Swarm network. It discovers peers and catches up with the latest state.
            </p>
            <p className="text-xs" style={{ color: 'rgb(var(--fg-muted))' }}>
              This can take 1–5 minutes. Nook is also reserving space for your identity &amp; messages.
            </p>
          </div>
        )}

        {/* Step 3 — Fund wallet (rev C, user-approved 2026-09-22: one short
            "why" up top, the any-chain line inside the widget card, the
            address as a Gnosis-Chain instruction, check-now merged with the
            auto-advance note at the bottom). */}
        {step === 'funding' && (
          <div className="space-y-5">
            <div className="text-center space-y-3">
              <h2 className="text-lg font-semibold">Top up your node wallet</h2>
              <p className="text-sm leading-relaxed" style={{ color: 'rgb(var(--fg-muted))' }}>
                Nook doesn't use servers — your files and messages live on Swarm, a decentralized network. You pay
                upfront for the space you use. To finish setup, top up your node wallet with 5 xBZZ.
              </p>
            </div>

            {/* Multichain widget */}
            <div className="rounded-xl border p-5" style={{ backgroundColor: 'rgb(var(--bg-surface))' }}>
              <p className="text-xs uppercase tracking-widest mb-1" style={{ color: 'rgb(var(--fg-muted))' }}>
                Top up
              </p>
              <p className="text-xs mb-3" style={{ color: 'rgb(var(--fg-muted))' }}>
                Fund from any EVM-compatible chain using any token — it's swapped automatically.
              </p>
              {address ? (
                <MultichainWidget
                  destination={address}
                  intent="arbitrary"
                  theme={WIDGET_THEME}
                  hooks={{ onCompletion: async () => setStep('syncing') }}
                />
              ) : (
                <div className="flex items-center gap-2">
                  <Loader2 size={12} className="animate-spin" style={{ color: 'rgb(var(--fg-muted))' }} />
                  <p className="text-xs" style={{ color: 'rgb(var(--fg-muted))' }}>
                    Waiting for wallet address…
                  </p>
                </div>
              )}
            </div>

            {/* Or send directly — the address as a concrete instruction, with
                the wrong-chain warning (irreversible-loss class). */}
            {address && (
              <div className="rounded-xl border p-5 space-y-2" style={{ backgroundColor: 'rgb(var(--bg-surface))' }}>
                <p className="text-xs uppercase tracking-widest" style={{ color: 'rgb(var(--fg-muted))' }}>
                  Send directly to node address
                </p>
                <p className="text-xs" style={{ color: 'rgb(var(--fg-muted))' }}>
                  Send xDAI and xBZZ to your node address on <b style={{ color: 'rgb(var(--fg))' }}>Gnosis Chain</b>:
                </p>
                <div className="flex items-center gap-2">
                  <p className="font-mono text-xs min-w-0 truncate flex-1" style={{ color: 'rgb(var(--fg))' }}>
                    {address}
                  </p>
                  <button
                    onClick={copyAddress}
                    className="w-6 h-6 flex items-center justify-center rounded shrink-0 transition-colors"
                    style={{ color: copiedAddr ? '#4ade80' : 'rgb(var(--fg-muted))' }}
                  >
                    {copiedAddr ? <Check size={12} /> : <Copy size={12} />}
                  </button>
                </div>
                {/* Always visible, never a tooltip: irreversible-loss class,
                    and the user who needs it won't hover. Compact under the
                    address (user-picked placement). */}
                <p className="text-[11px]" style={{ color: '#f59e0b' }}>
                  ⚠ Gnosis Chain only — funds sent from other networks won't appear in Nook and are hard to recover.
                </p>
              </div>
            )}

            {/* Gift code */}
            <div className="rounded-xl border p-5" style={{ backgroundColor: 'rgb(var(--bg-surface))' }}>
              <p className="text-xs uppercase tracking-widest mb-1" style={{ color: 'rgb(var(--fg-muted))' }}>
                Redeem gift code
              </p>
              <p className="text-xs mb-3" style={{ color: 'rgb(var(--fg-muted))' }}>
                Have a gift code? Paste it to receive xBZZ and xDAI instantly.
              </p>
              <div className="flex gap-3">
                <input
                  type="text"
                  value={giftCode}
                  onChange={e => setGiftCode(e.target.value)}
                  onKeyDown={async e => e.key === 'Enter' && redeem()}
                  placeholder="Gift code…"
                  className="flex-1 rounded-lg border px-3 py-2 text-sm font-mono focus:outline-none"
                  style={{ backgroundColor: 'rgb(var(--bg))', color: 'rgb(var(--fg))' }}
                />
                <button
                  onClick={redeem}
                  disabled={redeeming || !giftCode.trim()}
                  className="px-4 py-2 rounded-lg text-sm font-semibold disabled:opacity-40 transition-opacity shrink-0"
                  style={{
                    backgroundColor: redeemDone ? 'rgba(74,222,128,0.15)' : 'rgb(var(--accent))',
                    color: redeemDone ? '#4ade80' : '#fff',
                  }}
                >
                  {redeeming ? 'Redeeming…' : redeemDone ? 'Done' : 'Redeem'}
                </button>
              </div>
              {redeemError && (
                <p className="text-xs mt-3" style={{ color: '#ef4444' }}>
                  {redeemError}
                </p>
              )}
              {redeemDone && (
                <p className="text-xs mt-3" style={{ color: '#4ade80' }}>
                  Gift code redeemed — balance will update shortly.
                </p>
              )}
            </div>

            {/* Beta disclaimer — short form (rev C). */}
            <div
              className="flex items-start gap-3 rounded-xl border px-5 py-3 text-left"
              style={{ backgroundColor: 'rgb(var(--bg-surface))' }}
            >
              <AlertTriangle size={14} className="shrink-0 mt-0.5" style={{ color: '#f97316' }} />
              <p className="text-xs leading-relaxed" style={{ color: 'rgb(var(--fg-muted))' }}>
                Nook is beta software. Use small amounts only.
              </p>
            </div>

            {/* Auto-advance + manual re-check, one line (fresh-install
                feedback 2026-09-17 + rev C: silent polling reads as stuck). */}
            <p className="text-xs text-center" style={{ color: 'rgb(var(--fg-muted))' }}>
              Nook checks your wallet every 15 seconds and moves on automatically — or{' '}
              <button
                onClick={() => void refetchWallet()}
                disabled={walletChecking}
                className="underline transition-colors"
                style={{ color: 'rgb(var(--fg-muted))' }}
              >
                {walletChecking ? 'checking…' : "I've sent funds — check now"}
              </button>
            </p>
            <p className="text-[11px] text-center" style={{ color: 'rgb(var(--fg-muted))' }}>
              Using MetaMask? Unlock it first — if it doesn't show up in the box above, refresh this page.
            </p>
          </div>
        )}

        {/* Step 5 — Ready */}
        {step === 'ready' && (
          <div className="text-center space-y-6">
            <div
              className="w-14 h-14 rounded-full mx-auto flex items-center justify-center"
              style={{ backgroundColor: 'rgba(74,222,128,0.15)' }}
            >
              <Check size={28} style={{ color: '#4ade80' }} />
            </div>
            <h2 className="text-lg font-semibold">Your node is ready</h2>
            <p className="text-sm leading-relaxed" style={{ color: 'rgb(var(--fg-muted))' }}>
              Your Bee node is connected and funded. You can now create a drive and start uploading files to the Swarm
              network.
            </p>
            <button
              onClick={finish}
              className="px-6 py-3 rounded-lg text-sm font-semibold transition-opacity"
              style={{ backgroundColor: 'rgb(var(--accent))', color: 'rgb(var(--primary-foreground))' }}
            >
              Create your first drive →
            </button>
          </div>
        )}

        {/* Skip link — new users only (the identity step has its own skip) */}
        {!skipReady && step !== 'ready' && step !== 'identity' && (
          <div className="text-center mt-8">
            <button
              onClick={skip}
              className="text-xs underline transition-colors"
              style={{ color: 'rgb(var(--fg-muted))' }}
            >
              Skip setup
            </button>
            <p className="text-[10px] mt-1" style={{ color: 'rgb(var(--fg-muted))' }}>
              Things won't work until all steps are complete.
            </p>
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * Identity step — connect wallet, derive the Nook identity, done. Free and
 * instant, so it runs BEFORE funding (nothing to wait for here). The actual
 * network publish still happens automatically once the reserved space exists
 * (useAutoPublish) — the setup≠publish split is unchanged. Skipping is quiet
 * and always possible; the Identity tab is the recovery path.
 */
function OnboardingIdentityStep({ onContinue }: { onContinue: () => void }) {
  const { signer, derive, deriving, error, walletConnected } = useDerivedKey()

  if (signer) {
    return (
      <div className="text-center space-y-5">
        <div
          className="w-14 h-14 rounded-full mx-auto flex items-center justify-center"
          style={{ backgroundColor: 'rgba(74,222,128,0.15)' }}
        >
          <Check size={28} style={{ color: '#4ade80' }} />
        </div>
        <h2 className="text-lg font-semibold">Identity created</h2>
        <p className="text-sm leading-relaxed" style={{ color: 'rgb(var(--fg-muted))' }}>
          You'll be findable by your Nook address, so contacts can message you and share drives with you. You can change
          this anytime in Account → Identity.
        </p>
        <button
          onClick={onContinue}
          className="px-6 py-3 rounded-lg text-sm font-semibold transition-opacity"
          style={{ backgroundColor: 'rgb(var(--accent))', color: 'rgb(var(--primary-foreground))' }}
        >
          Continue →
        </button>
      </div>
    )
  }

  return (
    <div className="text-center space-y-5">
      <h2 className="text-lg font-semibold">Create your identity</h2>
      <p className="text-sm leading-relaxed" style={{ color: 'rgb(var(--fg-muted))' }}>
        Your identity is how contacts message you and share drives with you. It's derived from your wallet with two
        signatures — free, no transaction, and nothing leaves your device.
      </p>
      {!walletConnected ? (
        <ConnectButton.Custom>
          {({ openConnectModal, connectModalOpen }) => (
            <button
              onClick={openConnectModal}
              disabled={connectModalOpen}
              className="px-6 py-3 rounded-lg text-sm font-semibold transition-opacity"
              style={{ backgroundColor: 'rgb(var(--accent))', color: 'rgb(var(--primary-foreground))' }}
            >
              Connect wallet &amp; create
            </button>
          )}
        </ConnectButton.Custom>
      ) : (
        <button
          onClick={async () => derive()}
          disabled={deriving}
          className="px-6 py-3 rounded-lg text-sm font-semibold transition-opacity disabled:opacity-60"
          style={{ backgroundColor: 'rgb(var(--accent))', color: 'rgb(var(--primary-foreground))' }}
        >
          {deriving ? 'Check your wallet — approve the signatures…' : 'Create identity'}
        </button>
      )}
      {error && (
        <p className="text-xs" style={{ color: '#ef4444' }}>
          {error}
        </p>
      )}
      <div>
        <button
          onClick={onContinue}
          className="text-xs underline transition-colors"
          style={{ color: 'rgb(var(--fg-muted))' }}
        >
          Skip for now
        </button>
        <p className="text-[10px] mt-1" style={{ color: 'rgb(var(--fg-muted))' }}>
          Messaging and sharing stay off until you create one — Account → Identity picks this up later.
        </p>
      </div>
    </div>
  )
}
