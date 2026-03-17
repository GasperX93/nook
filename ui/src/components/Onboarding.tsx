import { AlertTriangle, Check, Copy, Gift, Loader2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import '@rainbow-me/rainbowkit/styles.css'
import '@upcoming/multichain-widget/styles.css'
import { MultichainWidget } from '@upcoming/multichain-widget'
import { weiToDai } from '../api/bee'
import { api } from '../api/client'
import { useAddresses, useBeeHealth, useStamps, useStatus, useWallet } from '../api/queries'
import { useAppStore } from '../store/app'
import { WIDGET_THEME } from '../theme'

type Step = 'starting' | 'info' | 'funding' | 'syncing' | 'ready'

const STEPS: Step[] = ['starting', 'info', 'funding', 'syncing', 'ready']

export default function Onboarding({ skipReady = false }: { skipReady?: boolean }) {
  const navigate = useNavigate()
  const { setOnboardingCompleted } = useAppStore()

  const { isSuccess: beeOnline } = useBeeHealth()
  const { data: status } = useStatus()
  const { isSuccess: stampsReady } = useStamps()
  const { data: wallet } = useWallet()
  const { data: addresses } = useAddresses()

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
  // starting → info (manual continue) → funding → syncing → ready
  // Returning users (skipReady): skip info+funding, go straight to syncing
  useEffect(() => {
    if (lockedStep) return

    if (step !== 'starting' || !startingMinElapsed) return

    if (skipReady && beeOnline) {
      setStep('syncing')

      return
    }

    // Once Bee is online or mode is known, advance to info step
    if (status?.mode === 'ultra-light' || beeOnline) setStep('info')
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

        {/* Step 1 — Node starting */}
        {step === 'starting' && (
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

        {/* Step 2 — Info / disclaimer */}
        {step === 'info' && (
          <div className="text-center space-y-5">
            <h2 className="text-lg font-semibold">Next, fund your node wallet.</h2>
            <p className="text-sm leading-relaxed" style={{ color: 'rgb(var(--fg-muted))' }}>
              Your node needs xDAI for transaction fees and xBZZ for storage space on the Swarm network.
            </p>
            <div
              className="flex items-start gap-3 rounded-xl border px-5 py-4 text-left"
              style={{ backgroundColor: 'rgb(var(--bg-surface))' }}
            >
              <AlertTriangle size={16} className="shrink-0 mt-0.5" style={{ color: '#f97316' }} />
              <p className="text-xs leading-relaxed" style={{ color: 'rgb(var(--fg-muted))' }}>
                Nook is beta software. Use small amounts only — features may change, bugs may exist, and stored data may
                need to be re-uploaded after updates.
              </p>
            </div>
            <button
              onClick={() => setStep('funding')}
              className="px-6 py-3 rounded-lg text-sm font-semibold transition-opacity"
              style={{ backgroundColor: 'rgb(var(--accent))', color: '#fff' }}
            >
              Continue →
            </button>
          </div>
        )}

        {/* Step 3 — Syncing */}
        {step === 'syncing' && (
          <div className="text-center space-y-4">
            <Loader2 size={32} className="animate-spin mx-auto" style={{ color: '#f97316' }} />
            <h2 className="text-lg font-semibold">Connecting to the network</h2>
            <p className="text-sm leading-relaxed" style={{ color: 'rgb(var(--fg-muted))' }}>
              Your node is syncing with the Swarm network. It discovers peers and catches up with the latest state.
            </p>
            <p className="text-xs" style={{ color: 'rgb(var(--fg-muted))' }}>
              This can take 1–5 minutes.
            </p>
          </div>
        )}

        {/* Step 4 — Fund wallet */}
        {step === 'funding' && (
          <div className="space-y-5">
            <div className="text-center space-y-3">
              <h2 className="text-lg font-semibold">Fund your node wallet.</h2>
              <p className="text-sm leading-relaxed" style={{ color: 'rgb(var(--fg-muted))' }}>
                Your node needs xDAI for transaction fees and xBZZ for storage space on the Swarm network.
              </p>
              <p className="text-sm leading-relaxed" style={{ color: 'rgb(var(--fg-muted))' }}>
                You can fund it from any EVM-compatible chain using any token — it will be swapped to the required
                assets.
              </p>
            </div>

            {/* Wallet address */}
            {address && (
              <div
                className="flex items-center gap-2 rounded-lg px-4 py-3"
                style={{ backgroundColor: 'rgb(var(--bg-surface))' }}
              >
                <span className="text-xs uppercase tracking-widest shrink-0" style={{ color: 'rgb(var(--fg-muted))' }}>
                  Your node address
                </span>
                <p className="font-mono text-xs min-w-0 truncate flex-1" style={{ color: 'rgb(var(--fg-muted))' }}>
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
            )}

            {/* Multichain widget */}
            <div className="rounded-xl border p-5" style={{ backgroundColor: 'rgb(var(--bg-surface))' }}>
              <p className="text-xs uppercase tracking-widest mb-3" style={{ color: 'rgb(var(--fg-muted))' }}>
                Top up
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

            {/* Gift code */}
            <div className="rounded-xl border p-5" style={{ backgroundColor: 'rgb(var(--bg-surface))' }}>
              <div className="flex items-center gap-2 mb-1">
                <Gift size={13} style={{ color: 'rgb(var(--accent))' }} />
                <p className="text-xs uppercase tracking-widest" style={{ color: 'rgb(var(--fg-muted))' }}>
                  Redeem gift code
                </p>
              </div>
              <p className="text-xs mb-3" style={{ color: 'rgb(var(--fg-muted))' }}>
                Have a gift code? Paste it to receive BZZ and xDAI instantly.
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

            <p className="text-xs text-center" style={{ color: 'rgb(var(--fg-muted))' }}>
              This step will advance automatically once xDAI is detected in your wallet.
            </p>
          </div>
        )}

        {/* Step 4 — Ready */}
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
              style={{ backgroundColor: 'rgb(var(--accent))', color: '#fff' }}
            >
              Create your first drive →
            </button>
          </div>
        )}

        {/* Skip link — new users only */}
        {!skipReady && step !== 'ready' && (
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
