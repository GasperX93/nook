import { UserCircle2 } from 'lucide-react'
import { useEffect, useState } from 'react'

import { useDerivedKey } from '../hooks/useDerivedKey'
import { getSwarmId, onSwarmIdChange, swarmIdIdentity } from '../swarm-id'

/**
 * The signed-in Swarm ID account's display name + avatar. The name persists
 * with the identity cache; the avatar only exists on a live SDK session, so
 * the client is warmed once a signer is active (it is otherwise lazy).
 */
export function useSwarmIdProfile(): { name: string | null; avatarUrl: string | null } {
  const { signer, swarmIdAccount } = useDerivedKey()
  const [live, setLive] = useState(() => swarmIdIdentity())

  useEffect(() => {
    if (!signer) return
    let cancelled = false

    getSwarmId()
      .then(() => {
        if (!cancelled) setLive(swarmIdIdentity())
      })
      .catch(() => undefined)
    const unsubscribe = onSwarmIdChange(() => setLive(swarmIdIdentity()))

    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [signer])

  if (!signer) return { name: null, avatarUrl: null }

  return { name: live?.name || swarmIdAccount?.name || null, avatarUrl: live?.avatar?.url ?? null }
}

export function SwarmIdAvatar({ url, size = 16 }: { url: string | null; size?: number }) {
  return url ? (
    <img src={url} alt="" className="rounded-full shrink-0" style={{ width: size, height: size }} />
  ) : (
    <UserCircle2 size={size} className="shrink-0" style={{ color: 'rgb(var(--fg-muted))' }} />
  )
}

/** "Gx93 · Swarm ID" pill — who the user is signed in as. */
export default function SwarmIdBadge({ suffix = 'Swarm ID' }: { suffix?: string }) {
  const { name, avatarUrl } = useSwarmIdProfile()

  return (
    <span
      className="inline-flex items-center gap-2 rounded-full border pl-1.5 pr-3 py-1 text-sm"
      style={{ backgroundColor: 'rgb(var(--bg-surface))', borderColor: 'rgb(var(--border))' }}
    >
      <SwarmIdAvatar url={avatarUrl} size={20} />
      <span className="font-semibold">{name ?? 'Signed in'}</span>
      <span style={{ color: 'rgb(var(--fg-muted))' }}>· {suffix}</span>
    </span>
  )
}
