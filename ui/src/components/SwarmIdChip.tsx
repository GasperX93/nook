import { LogOut, UserCircle2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import { useDerivedKey } from '../hooks/useDerivedKey'
import { getSwarmId, onSwarmIdChange, signOutOfSwarmId, swarmIdIdentity } from '../swarm-id'

/**
 * Header identity chip — replaces the global wallet
 * Connect button. Identity comes from Swarm ID; wallets appear only inside
 * payment flows (Top Up).
 */
export default function SwarmIdChip() {
  const { signer, signIn, deriving, clear } = useDerivedKey()
  const [accountName, setAccountName] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  // Warm the SDK client when a Swarm ID identity is active, so the account's
  // display name is available after a reload (the client is otherwise lazy).
  useEffect(() => {
    if (!signer) return
    let cancelled = false

    getSwarmId()
      .then(() => {
        if (!cancelled) setAccountName(swarmIdIdentity()?.name ?? null)
      })
      .catch(() => undefined)
    const unsubscribe = onSwarmIdChange(() => setAccountName(swarmIdIdentity()?.name ?? null))

    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [signer])

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
  const label = accountName ?? `${address.slice(0, 6)}…${address.slice(-4)}`

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
        <UserCircle2 size={14} />
        {label}
      </button>

      {open && (
        <div
          className="absolute right-0 top-full mt-1 rounded-lg border z-50 min-w-[180px] py-1"
          style={{ backgroundColor: 'rgb(var(--bg-surface))', borderColor: 'rgb(var(--border))' }}
        >
          <p className="px-3 py-2 text-[10px] font-mono truncate" style={{ color: 'rgb(var(--fg-muted))' }}>
            {address}
          </p>
          <button
            onClick={() => void signOut()}
            className="flex items-center gap-2 w-full px-3 py-2 text-xs text-left transition-colors hover:bg-white/5"
            style={{ color: 'rgb(var(--fg))' }}
          >
            <LogOut size={12} />
            Sign out
          </button>
        </div>
      )}
    </div>
  )
}
