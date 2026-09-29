import { Check, Copy, LogOut } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import { useDerivedKey } from '../hooks/useDerivedKey'
import { signOutOfSwarmId } from '../swarm-id'
import { SwarmIdAvatar, useSwarmIdProfile } from './SwarmIdBadge'

/**
 * Header identity chip — replaces the global wallet Connect button. Identity
 * comes from Swarm ID; wallets appear only inside payment flows (Top Up).
 * Signing out wipes only the cached secret: contacts and messages stay on this
 * machine and come back when the same Swarm ID signs in again.
 */
export default function SwarmIdChip() {
  const { signer, signIn, deriving, clear } = useDerivedKey()
  const { name, avatarUrl } = useSwarmIdProfile()
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)

    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  if (!signer) {
    return (
      <button
        onClick={async () => signIn()}
        disabled={deriving}
        className="nook-wallet-btn flex items-center gap-2 px-3 py-1.5 rounded-full text-xs transition-colors border"
      >
        {deriving ? 'Signing in…' : 'Sign in'}
      </button>
    )
  }

  const address = signer.getAddress()
  const shortAddress = `${address.slice(0, 6)}…${address.slice(-4)}`

  async function copyAddress() {
    await navigator.clipboard.writeText(address)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  async function signOut() {
    setOpen(false)
    await signOutOfSwarmId().catch(() => undefined)
    await clear()
  }

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(v => !v)}
        className="nook-wallet-btn flex items-center gap-2 px-3 py-1.5 rounded-full text-xs transition-colors border"
      >
        <SwarmIdAvatar url={avatarUrl} size={14} />
        {name ?? shortAddress}
      </button>

      {open && (
        <div
          className="absolute right-0 top-full mt-1 rounded-lg border z-50 min-w-[240px] py-1"
          style={{ backgroundColor: 'rgb(var(--bg-surface))', borderColor: 'rgb(var(--border))' }}
        >
          <div className="px-3 pt-2 pb-2.5 border-b" style={{ borderColor: 'rgb(var(--border))' }}>
            <p className="flex items-center gap-2 text-xs font-semibold">
              <SwarmIdAvatar url={avatarUrl} size={14} />
              {name ?? 'Signed in'}
            </p>
            <p className="text-[10px] mt-0.5" style={{ color: 'rgb(var(--fg-muted))' }}>
              Signed in with Swarm ID
            </p>
          </div>
          <button
            onClick={() => void copyAddress()}
            className="flex items-center justify-between gap-3 w-full px-3 py-2 text-xs text-left transition-colors hover:bg-white/5"
            style={{ color: 'rgb(var(--fg))' }}
            title="Copy Nook address"
          >
            <span>Nook address</span>
            <span className="flex items-center gap-1.5 font-mono" style={{ color: 'rgb(var(--fg-muted))' }}>
              {shortAddress}
              {copied ? <Check size={11} style={{ color: 'rgb(74,222,128)' }} /> : <Copy size={11} />}
            </span>
          </button>
          <button
            onClick={() => void signOut()}
            className="flex items-center gap-2 w-full px-3 py-2 text-xs text-left transition-colors hover:bg-white/5 border-t"
            style={{ color: 'rgb(var(--fg))', borderColor: 'rgb(var(--border))' }}
          >
            <LogOut size={12} />
            Sign out
          </button>
        </div>
      )}
    </div>
  )
}
