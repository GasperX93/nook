/**
 * WalletGate — inline prompt to sign in for encrypted drive operations
 * (identity comes from Swarm ID, not a wallet; the component keeps its name
 * to avoid touching every import).
 */
import { UserCircle2 } from 'lucide-react'

import { useDerivedKey } from '../hooks/useDerivedKey'
import { Button } from './ui/button'

interface WalletGateProps {
  message?: string
}

export default function WalletGate({
  message = 'Sign in with Swarm ID to set up your encrypted drive.',
}: WalletGateProps) {
  const { signIn, deriving } = useDerivedKey()

  return (
    <div
      className="rounded-lg border p-4 flex flex-col items-center gap-3"
      style={{ backgroundColor: 'rgb(var(--bg))', borderColor: 'rgb(var(--border))' }}
    >
      <UserCircle2 size={20} style={{ color: 'rgb(var(--fg-muted))' }} />
      <p className="text-xs text-center" style={{ color: 'rgb(var(--fg-muted))' }}>
        {message}
      </p>
      <Button onClick={async () => signIn()} disabled={deriving} size="sm">
        {deriving ? 'Signing in…' : 'Sign in with Swarm ID'}
      </Button>
    </div>
  )
}
