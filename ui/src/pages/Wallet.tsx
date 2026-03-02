import { useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, Check, Copy, Gift } from 'lucide-react'
import { useState } from 'react'
import '@rainbow-me/rainbowkit/styles.css'
import '@upcoming/multichain-widget/styles.css'
import { MultichainWidget } from '@upcoming/multichain-widget'
import { weiToDai, plurToBzz } from '../api/bee'
import { api } from '../api/client'
import { useAddresses, useBeeHealth, useWallet } from '../api/queries'
import { useAppStore } from '../store/app'

const WIDGET_THEME = {
  backgroundColor: '#0f1117',
  inputBackgroundColor: '#181b23',
  inputBorderColor: '#262a36',
  inputTextColor: '#f0f4f8',
  textColor: '#f0f4f8',
  secondaryTextColor: '#78829690',
  buttonBackgroundColor: '#f76808',
  buttonTextColor: '#ffffff',
  buttonSecondaryBackgroundColor: '#262a36',
  buttonSecondaryTextColor: '#f0f4f8',
  errorTextColor: '#ef4444',
  borderRadius: '8px',
  fontFamily: "ui-monospace, 'Cascadia Code', 'Fira Code', monospace",
  fontSize: '13px',
  fontWeight: 400,
  smallFontSize: '11px',
  smallFontWeight: 400,
  labelSpacing: '0.1em',
  inputVerticalPadding: '8px',
  inputHorizontalPadding: '12px',
  buttonVerticalPadding: '10px',
  buttonHorizontalPadding: '16px',
}

export default function Wallet() {
  const queryClient = useQueryClient()
  const { data: wallet, isError: walletError } = useWallet()
  const { data: addresses } = useAddresses()
  const { isSuccess: beeOnline } = useBeeHealth()
  const [copiedAddr, setCopiedAddr] = useState(false)
  const [swapAmount, setSwapAmount] = useState('')
  const [swapping, setSwapping] = useState(false)
  const [swapError, setSwapError] = useState<string | null>(null)
  const [swapDone, setSwapDone] = useState(false)
  const [giftCode, setGiftCode] = useState('')
  const [redeeming, setRedeeming] = useState(false)
  const [redeemError, setRedeemError] = useState<string | null>(null)
  const [redeemDone, setRedeemDone] = useState(false)

  const syncing = beeOnline && walletError
  const bzz = wallet ? Number(plurToBzz(wallet.bzzBalance)).toFixed(4) : syncing ? 'syncing…' : '—'
  const dai = wallet ? Number(weiToDai(wallet.nativeTokenBalance)).toFixed(4) : syncing ? 'syncing…' : '—'
  const address = addresses?.ethereum ?? ''
  const isEmpty =
    wallet &&
    Number(plurToBzz(wallet.bzzBalance)) === 0 &&
    Number(weiToDai(wallet.nativeTokenBalance)) === 0

  function copyAddress() {
    navigator.clipboard.writeText(address)
    setCopiedAddr(true)
    setTimeout(() => setCopiedAddr(false), 2000)
  }

  async function swap() {
    if (!swapAmount) return
    setSwapping(true)
    setSwapError(null)
    setSwapDone(false)
    try {
      const apiKey = useAppStore.getState().apiKey
      const res = await fetch('/swap', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(apiKey ? { authorization: apiKey } : {}) },
        body: JSON.stringify({ dai: swapAmount }),
      })
      if (!res.ok) throw new Error(`Swap failed: ${res.status}`)
      setSwapDone(true)
      setSwapAmount('')
      queryClient.invalidateQueries({ queryKey: ['bee', 'wallet'] })
      setTimeout(() => setSwapDone(false), 3000)
    } catch (err) {
      setSwapError(err instanceof Error ? err.message : 'Swap failed')
    } finally {
      setSwapping(false)
    }
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
      // Refetch immediately, then poll every 3s for up to 30s to catch delayed settlement
      queryClient.refetchQueries({ queryKey: ['bee', 'wallet'] })
      let ticks = 0
      const poll = setInterval(() => {
        queryClient.refetchQueries({ queryKey: ['bee', 'wallet'] })
        if (++ticks >= 10) clearInterval(poll)
      }, 3000)
      setTimeout(() => setRedeemDone(false), 30_000)
    } catch (err) {
      setRedeemError(err instanceof Error ? err.message : 'Redeem failed')
    } finally {
      setRedeeming(false)
    }
  }

  return (
    <div className="p-6 max-w-4xl">
      <h1 className="text-base font-semibold uppercase tracking-widest mb-6" style={{ color: 'rgb(var(--fg-muted))' }}>
        Wallet
      </h1>

      <div className="space-y-5">
        {/* Address — full width slim row */}
          <div className="flex items-center gap-3 px-1">
            <span className="text-xs uppercase tracking-widest shrink-0" style={{ color: 'rgb(var(--fg-muted))' }}>
              Address
            </span>
            {address ? (
              <div className="flex items-center gap-1 min-w-0">
                <p className="font-mono text-xs min-w-0 truncate" style={{ color: 'rgb(var(--fg-muted))' }}>
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
            ) : (
              <p className="text-xs" style={{ color: 'rgb(var(--fg-muted))' }}>
                Not available
              </p>
            )}
          </div>

          {/* Empty wallet warning — full width */}
          {isEmpty && (
            <div className="flex items-start gap-2 rounded-lg px-4 py-3" style={{ backgroundColor: 'rgba(247,104,8,0.08)', border: '1px solid rgba(247,104,8,0.25)' }}>
              <AlertTriangle size={13} className="shrink-0 mt-0.5" style={{ color: '#f76808' }} />
              <p className="text-xs" style={{ color: '#f76808' }}>
                Your wallet is empty. You need funds to buy storage — top up below.
              </p>
            </div>
          )}

          {/* Two-column layout */}
          <div className="grid gap-5 items-stretch" style={{ gridTemplateColumns: '2fr 4fr' }}>

            {/* Left column: balances + swap + redeem */}
            <div className="flex flex-col gap-4 h-full">
              {/* Balances */}
              <div className="flex gap-3">
                <div className="rounded-xl border p-5 flex-1" style={{ backgroundColor: 'rgb(var(--bg-surface))' }}>
                  <p className="text-xs uppercase tracking-widest mb-3" style={{ color: 'rgb(var(--fg-muted))' }}>BZZ</p>
                  <div className="flex items-baseline gap-2">
                    <span className="text-3xl font-bold tabular-nums">{bzz}</span>
                    <span className="text-sm font-medium" style={{ color: 'rgb(var(--fg-muted))' }}>BZZ</span>
                  </div>
                  <p className="text-xs mt-2" style={{ color: 'rgb(var(--fg-muted))' }}>Used to buy storage</p>
                </div>
                <div className="rounded-xl border p-5 flex-1" style={{ backgroundColor: 'rgb(var(--bg-surface))' }}>
                  <p className="text-xs uppercase tracking-widest mb-3" style={{ color: 'rgb(var(--fg-muted))' }}>xDAI</p>
                  <div className="flex items-baseline gap-2">
                    <span className="text-3xl font-bold tabular-nums">{dai}</span>
                    <span className="text-sm font-medium" style={{ color: 'rgb(var(--fg-muted))' }}>xDAI</span>
                  </div>
                  <p className="text-xs mt-2" style={{ color: 'rgb(var(--fg-muted))' }}>Used for gas fees</p>
                </div>
              </div>

              {/* Swap */}
              <div className="rounded-xl border p-5" style={{ backgroundColor: 'rgb(var(--bg-surface))' }}>
                <p className="text-xs uppercase tracking-widest mb-1" style={{ color: 'rgb(var(--fg-muted))' }}>
                  Swap xDAI → BZZ
                </p>
                <p className="text-xs mb-4" style={{ color: 'rgb(var(--fg-muted))' }}>
                  Convert xDAI to BZZ to fund storage purchases.
                </p>
                <div className="flex gap-3">
                  <div className="relative flex-1">
                    <input
                      type="number"
                      value={swapAmount}
                      onChange={e => setSwapAmount(e.target.value)}
                      placeholder="0.00"
                      min="0"
                      className="w-full rounded-lg border px-3 py-2 text-sm pr-14 focus:outline-none"
                      style={{ backgroundColor: 'rgb(var(--bg))', color: 'rgb(var(--fg))' }}
                    />
                    <span
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-xs font-medium"
                      style={{ color: 'rgb(var(--fg-muted))' }}
                    >
                      xDAI
                    </span>
                  </div>
                  <button
                    onClick={swap}
                    disabled={swapping || !swapAmount}
                    className="px-4 py-2 rounded-lg text-sm font-semibold disabled:opacity-40 transition-opacity shrink-0"
                    style={{
                      backgroundColor: swapDone ? 'rgba(74,222,128,0.15)' : 'rgb(var(--accent))',
                      color: swapDone ? '#4ade80' : '#fff',
                    }}
                  >
                    {swapping ? 'Swapping…' : swapDone ? 'Done' : 'Swap'}
                  </button>
                </div>
                {swapError && (
                  <p className="text-xs mt-3" style={{ color: '#ef4444' }}>
                    {swapError}
                  </p>
                )}
              </div>

              {/* Redeem gift code */}
              <div className="rounded-xl border p-5 flex-1" style={{ backgroundColor: 'rgb(var(--bg-surface))' }}>
                <div className="flex items-center gap-2 mb-1">
                  <Gift size={13} style={{ color: 'rgb(var(--accent))' }} />
                  <p className="text-xs uppercase tracking-widest" style={{ color: 'rgb(var(--fg-muted))' }}>
                    Redeem gift code
                  </p>
                </div>
                <p className="text-xs mb-4" style={{ color: 'rgb(var(--fg-muted))' }}>
                  Paste a gift code to transfer its BZZ and xDAI to your node wallet.
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
                    Gift code redeemed — balance updated.
                  </p>
                )}
              </div>
            </div>

            {/* Right column: top up widget */}
            <div className="rounded-xl border p-5" style={{ backgroundColor: 'rgb(var(--bg-surface))' }}>
              <p className="text-xs uppercase tracking-widest mb-3" style={{ color: 'rgb(var(--fg-muted))' }}>
                Top up
              </p>
              {address ? (
                <>
                  <p className="text-xs mb-1" style={{ color: 'rgb(var(--fg-muted))' }}>
                    Fund your node wallet from any chain and any token.
                  </p>
                  <p className="text-xs mb-3" style={{ color: 'rgb(var(--fg-muted))' }}>
                    Set how much xDAI and xBZZ you want to top up to your node.
                  </p>
                  <MultichainWidget
                    destination={address}
                    intent="arbitrary"
                    theme={WIDGET_THEME}
                    hooks={{
                      onCompletion: async () => {
                        queryClient.invalidateQueries({ queryKey: ['bee', 'wallet'] })
                      },
                    }}
                  />
                </>
              ) : (
                <p className="text-xs" style={{ color: 'rgb(var(--fg-muted))' }}>
                  Wallet address not available.
                </p>
              )}
            </div>

          </div>
        </div>
    </div>
  )
}
