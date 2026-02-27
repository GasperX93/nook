import { useQueryClient } from '@tanstack/react-query'
import { Check, Copy, Gift } from 'lucide-react'
import { useState } from 'react'
import { weiToDai, plurToBzz } from '../api/bee'
import { api } from '../api/client'
import { useAddresses, useWallet } from '../api/queries'
import { useAppStore } from '../store/app'

function BalanceCard({ label, value, symbol, sub }: { label: string; value: string; symbol: string; sub?: string }) {
  return (
    <div className="rounded-xl border p-5 flex-1" style={{ backgroundColor: 'rgb(var(--bg-surface))' }}>
      <p className="text-xs uppercase tracking-widest mb-3" style={{ color: 'rgb(var(--fg-muted))' }}>
        {label}
      </p>
      <div className="flex items-baseline gap-2">
        <span className="text-3xl font-bold tabular-nums">{value}</span>
        <span className="text-sm font-medium" style={{ color: 'rgb(var(--fg-muted))' }}>
          {symbol}
        </span>
      </div>
      {sub && (
        <p className="text-xs mt-2" style={{ color: 'rgb(var(--fg-muted))' }}>
          {sub}
        </p>
      )}
    </div>
  )
}

export default function Wallet() {
  const queryClient = useQueryClient()
  const { data: wallet, isLoading: walletLoading } = useWallet()
  const { data: addresses, isLoading: addrLoading } = useAddresses()
  const [copiedAddr, setCopiedAddr] = useState(false)
  const [swapAmount, setSwapAmount] = useState('')
  const [swapping, setSwapping] = useState(false)
  const [swapError, setSwapError] = useState<string | null>(null)
  const [swapDone, setSwapDone] = useState(false)

  const [giftCode, setGiftCode] = useState('')
  const [redeeming, setRedeeming] = useState(false)
  const [redeemError, setRedeemError] = useState<string | null>(null)
  const [redeemDone, setRedeemDone] = useState(false)

  const bzz = wallet ? Number(plurToBzz(wallet.bzzBalance)).toFixed(4) : '—'
  const dai = wallet ? Number(weiToDai(wallet.nativeTokenBalance)).toFixed(4) : '—'
  const address = addresses?.ethereum ?? ''

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
      queryClient.invalidateQueries({ queryKey: ['bee', 'wallet'] })
      setTimeout(() => setRedeemDone(false), 4000)
    } catch (err) {
      setRedeemError(err instanceof Error ? err.message : 'Redeem failed')
    } finally {
      setRedeeming(false)
    }
  }

  const isLoading = walletLoading || addrLoading

  return (
    <div className="p-6 max-w-lg">
      <h1 className="text-base font-semibold uppercase tracking-widest mb-6" style={{ color: 'rgb(var(--fg-muted))' }}>
        Wallet
      </h1>

      {isLoading ? (
        <p className="text-sm" style={{ color: 'rgb(var(--fg-muted))' }}>
          Loading…
        </p>
      ) : (
        <div className="space-y-5">
          {/* Balances */}
          <div className="flex gap-3">
            <BalanceCard label="BZZ" value={bzz} symbol="BZZ" sub="Used to buy storage" />
            <BalanceCard label="xDAI" value={dai} symbol="xDAI" sub="Used for gas fees" />
          </div>

          {/* Address */}
          <div className="rounded-xl border p-5" style={{ backgroundColor: 'rgb(var(--bg-surface))' }}>
            <p className="text-xs uppercase tracking-widest mb-3" style={{ color: 'rgb(var(--fg-muted))' }}>
              Wallet address
            </p>
            {address ? (
              <div className="flex items-center gap-3">
                <p className="font-mono text-sm flex-1 truncate">{address}</p>
                <button
                  onClick={copyAddress}
                  className="w-7 h-7 flex items-center justify-center rounded shrink-0 transition-colors"
                  style={{ color: copiedAddr ? '#4ade80' : 'rgb(var(--fg-muted))' }}
                >
                  {copiedAddr ? <Check size={14} /> : <Copy size={14} />}
                </button>
              </div>
            ) : (
              <p className="text-sm" style={{ color: 'rgb(var(--fg-muted))' }}>
                Not available
              </p>
            )}
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
          <div className="rounded-xl border p-5" style={{ backgroundColor: 'rgb(var(--bg-surface))' }}>
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
      )}
    </div>
  )
}
