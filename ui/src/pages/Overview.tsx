import type { ReactNode } from 'react'
import type { NodeStatus } from '../api/client'
import { useInfo, usePeers, useRestart, useStatus } from '../api/queries'

const statusColor: Record<NodeStatus, string> = {
  running: '#4ade80',
  starting: '#facc15',
  stopped: 'rgb(var(--fg-muted))',
  error: '#f87171',
}

function StatCard({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div
      className="rounded-lg border p-4"
      style={{ backgroundColor: 'rgb(var(--bg-surface))' }}
    >
      <p className="text-xs uppercase tracking-widest mb-2" style={{ color: 'rgb(var(--fg-muted))' }}>
        {label}
      </p>
      <div className="text-lg font-semibold">{value}</div>
    </div>
  )
}

export default function Overview() {
  const { data: info, isLoading: infoLoading } = useInfo()
  const { data: status, isLoading: statusLoading } = useStatus()
  const { data: peers, isLoading: peersLoading } = usePeers()
  const restart = useRestart()

  const bee = status?.bee ?? 'stopped'
  const color = statusColor[bee] ?? 'rgb(var(--fg-muted))'

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-base font-semibold uppercase tracking-widest" style={{ color: 'rgb(var(--fg-muted))' }}>
          Node
        </h1>
        <button
          onClick={() => restart.mutate()}
          disabled={restart.isPending}
          className="px-3 py-1.5 rounded text-xs font-semibold uppercase tracking-widest transition-opacity disabled:opacity-40"
          style={{ backgroundColor: 'rgb(var(--accent))', color: '#fff' }}
        >
          {restart.isPending ? 'Restarting…' : 'Restart'}
        </button>
      </div>

      <div className="grid grid-cols-3 gap-3 mb-6">
        <StatCard
          label="Status"
          value={
            statusLoading ? (
              <span style={{ color: 'rgb(var(--fg-muted))' }}>—</span>
            ) : (
              <span className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full" style={{ backgroundColor: color }} />
                <span className="capitalize" style={{ color }}>{bee}</span>
              </span>
            )
          }
        />
        <StatCard
          label="Peers"
          value={
            peersLoading ? (
              <span style={{ color: 'rgb(var(--fg-muted))' }}>—</span>
            ) : (
              peers?.connections ?? 0
            )
          }
        />
        <StatCard
          label="Version"
          value={
            infoLoading ? (
              <span style={{ color: 'rgb(var(--fg-muted))' }}>—</span>
            ) : (
              <span className="text-sm">{info?.version ?? '—'}</span>
            )
          }
        />
      </div>

      {status?.config && (
        <div className="rounded-lg border p-4" style={{ backgroundColor: 'rgb(var(--bg-surface))' }}>
          <p className="text-xs uppercase tracking-widest mb-3" style={{ color: 'rgb(var(--fg-muted))' }}>
            Config
          </p>
          <pre className="text-xs overflow-auto" style={{ color: 'rgb(var(--fg-muted))' }}>
            {JSON.stringify(status.config, null, 2)}
          </pre>
        </div>
      )}
    </div>
  )
}
