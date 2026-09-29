import { AlertTriangle } from 'lucide-react'

import type { ForeignBee } from '../api/client'

/**
 * Another Bee node holds Nook's ports (R5-11). Nook doesn't start its own node
 * and doesn't use the other one (its wallet and drives aren't Nook's), so the
 * dashboard shows this instead of pages that would read the wrong node.
 */
export default function ForeignBeeScreen({
  foreignBee,
  onRetry,
  retrying,
}: {
  foreignBee: ForeignBee
  onRetry: () => void
  retrying: boolean
}) {
  return (
    <div className="flex-1 flex items-center justify-center p-8">
      <div className="max-w-md space-y-4 text-center">
        <AlertTriangle size={28} className="mx-auto" style={{ color: '#f97316' }} />
        <h2 className="text-lg font-semibold">Another Swarm node is running on this computer</h2>
        <p className="text-sm leading-relaxed" style={{ color: 'rgb(var(--fg-muted))' }}>
          Nook runs its own node, and it can’t share port {foreignBee.port} with another one. Stop the other node — a{' '}
          <code className="text-xs">bee</code> command in a terminal, a Docker container or another Swarm app — then try
          again.
        </p>
        {foreignBee.address && (
          <p className="text-xs" style={{ color: 'rgb(var(--fg-muted))' }}>
            The other node: <code className="text-xs break-all">{foreignBee.address}</code>
          </p>
        )}
        <p className="text-xs" style={{ color: 'rgb(var(--fg-muted))' }}>
          Nook won’t use that node or its funds. Your own node, drives and wallet are unchanged.
        </p>
        <button
          onClick={onRetry}
          disabled={retrying}
          className="px-4 py-2 rounded-lg text-sm font-semibold disabled:opacity-50"
          style={{ backgroundColor: 'rgb(var(--accent))', color: 'rgb(var(--primary-foreground))' }}
        >
          {retrying ? 'Checking…' : 'Try again'}
        </button>
      </div>
    </div>
  )
}
