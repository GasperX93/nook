import { ExternalLink } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useAddresses, useBeeHealth, useConfig, useInfo, usePeers, useTopology, useUpdateConfig } from '../api/queries'
import { useAppStore } from '../store/app'

type SettingsTab = 'general' | 'network'

const DEFAULT_RPC = 'https://rpc.gnosischain.com'

export default function Settings() {
  const [searchParams] = useSearchParams()
  const [tab, setTab] = useState<SettingsTab>(() => {
    const t = searchParams.get('tab')
    return t === 'network' ? 'network' : 'general'
  })
  const navigate = useNavigate()

  const { data: config, isLoading, isError: configError } = useConfig()
  const { data: info } = useInfo()
  const updateConfig = useUpdateConfig()

  const { data: health } = useBeeHealth()
  const { data: peers } = usePeers()
  const { data: topology } = useTopology()
  const { data: addresses } = useAddresses()

  const [rpcDraft, setRpcDraft] = useState('')
  const [rpcSaved, setRpcSaved] = useState(false)

  const { devMode, setDevMode } = useAppStore()

  useEffect(() => {
    if (config) {
      setRpcDraft((config['blockchain-rpc-endpoint'] as string | undefined) ?? DEFAULT_RPC)
    }
  }, [config])

  function saveRpc() {
    if (!config) return
    const url = rpcDraft.trim() || DEFAULT_RPC
    setRpcDraft(url)
    updateConfig.mutate(
      { ...config, 'blockchain-rpc-endpoint': url },
      {
        onSuccess: () => {
          setRpcSaved(true)
          setTimeout(() => setRpcSaved(false), 2000)
        },
      },
    )
  }

  return (
    <div className="p-6 max-w-xl space-y-6">
      <h1 className="text-base font-semibold uppercase tracking-widest" style={{ color: 'rgb(var(--fg-muted))' }}>
        Settings
      </h1>

      {/* Tabs */}
      <div className="flex gap-1 mb-6 border-b" style={{ borderColor: 'rgb(var(--border))' }}>
        {(['general', 'network'] as SettingsTab[]).map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className="px-4 py-2 text-sm font-medium transition-colors relative capitalize"
            style={{ color: tab === t ? 'rgb(var(--fg))' : 'rgb(var(--fg-muted))' }}
          >
            {t}
            {tab === t && (
              <span
                className="absolute bottom-0 left-0 right-0 h-0.5 rounded-t"
                style={{ backgroundColor: 'rgb(var(--accent))' }}
              />
            )}
          </button>
        ))}
      </div>

      {tab === 'general' && (
        <>
          {/* Blockchain RPC URL */}
          <div className="rounded-xl border p-5 space-y-4" style={{ backgroundColor: 'rgb(var(--bg-surface))' }}>
            <div>
              <p className="text-sm mb-1" style={{ color: 'rgb(var(--fg-muted))' }}>
                Blockchain RPC URL
              </p>
              <p className="text-xs" style={{ color: 'rgb(var(--fg-muted))' }}>
                Gnosis Chain RPC endpoint used for wallet and swap.
              </p>
            </div>
            {isLoading ? (
              <p className="text-xs" style={{ color: 'rgb(var(--fg-muted))' }}>Loading…</p>
            ) : configError ? (
              <p className="text-xs" style={{ color: 'rgb(var(--fg-muted))' }}>Nook backend not available.</p>
            ) : (
              <div className="flex gap-3">
                <input
                  type="text"
                  value={rpcDraft}
                  onChange={e => setRpcDraft(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && saveRpc()}
                  placeholder={DEFAULT_RPC}
                  className="flex-1 rounded-lg border px-3 py-2 text-xs font-mono focus:outline-none"
                  style={{ backgroundColor: 'rgb(var(--bg))', color: 'rgb(var(--fg))' }}
                />
                <button
                  onClick={saveRpc}
                  disabled={updateConfig.isPending}
                  className="px-4 py-2 rounded-lg text-xs font-semibold shrink-0 transition-colors disabled:opacity-40"
                  style={{
                    backgroundColor: rpcSaved ? 'rgba(74,222,128,0.15)' : 'rgb(var(--accent))',
                    color: rpcSaved ? '#4ade80' : '#fff',
                  }}
                >
                  {rpcSaved ? 'Saved' : 'Save'}
                </button>
              </div>
            )}
          </div>

          {/* Version info */}
          <div className="rounded-xl border p-5 space-y-3" style={{ backgroundColor: 'rgb(var(--bg-surface))' }}>
            <p className="text-sm mb-1" style={{ color: 'rgb(var(--fg-muted))' }}>
              About
            </p>
            <div className="flex justify-between text-xs" style={{ color: 'rgb(var(--fg-muted))' }}>
              <span>Nook</span>
              <span className="font-mono">{info?.version ?? '—'}</span>
            </div>
            <div className="flex flex-col gap-2 pt-1">
              <a
                href="https://github.com/GasperX93/nook"
                target="_blank"
                rel="noreferrer"
                className="flex items-center gap-2 text-xs transition-colors hover:underline"
                style={{ color: 'rgb(var(--fg-muted))' }}
              >
                <ExternalLink size={11} />
                GitHub
              </a>
              <a
                href="https://github.com/GasperX93/nook/issues/new/choose"
                target="_blank"
                rel="noreferrer"
                className="flex items-center gap-2 text-xs transition-colors hover:underline"
                style={{ color: 'rgb(var(--fg-muted))' }}
              >
                <ExternalLink size={11} />
                Report an issue or give feedback
              </a>
            </div>
          </div>
        </>
      )}

      {tab === 'network' && (
        <div className="space-y-3">
          {[
            { label: 'Connected peers', value: peers?.connections ?? '—' },
            { label: 'Network size', value: topology?.population ?? '—' },
            { label: 'Network depth', value: topology?.depth ?? '—' },
            { label: 'Bee version', value: health?.version ?? '—' },
            { label: 'Overlay address', value: addresses?.overlay ?? '—', mono: true },
            { label: 'Wallet address', value: addresses?.ethereum ?? '—', mono: true },
          ].map(({ label, value, mono }) => (
            <div
              key={label}
              className="rounded-xl border px-5 py-4 flex items-center justify-between gap-4"
              style={{ backgroundColor: 'rgb(var(--bg-surface))' }}
            >
              <p className="text-sm" style={{ color: 'rgb(var(--fg-muted))' }}>{label}</p>
              <p
                className={`text-xs text-right break-all ${mono ? 'font-mono' : 'font-semibold tabular-nums'}`}
                style={{ color: 'rgb(var(--fg))' }}
              >
                {String(value)}
              </p>
            </div>
          ))}

          {/* Developer mode toggle */}
          <div className="rounded-xl border p-5 space-y-3" style={{ backgroundColor: 'rgb(var(--bg-surface))' }}>
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm mb-1" style={{ color: 'rgb(var(--fg-muted))' }}>Developer mode</p>
                <p className="text-xs" style={{ color: 'rgb(var(--fg-muted))' }}>Shows logs and node configuration.</p>
              </div>
              <button
                role="switch"
                aria-checked={devMode}
                onClick={() => setDevMode(!devMode)}
                className="relative rounded-full transition-colors shrink-0"
                style={{
                  backgroundColor: devMode ? 'rgb(var(--accent))' : 'rgb(var(--border))',
                  width: 40,
                  height: 22,
                }}
              >
                <span
                  className="absolute top-0.5 rounded-full bg-white transition-transform"
                  style={{ width: 18, height: 18, left: 2, transform: devMode ? 'translateX(18px)' : 'translateX(0)' }}
                />
              </button>
            </div>
            {devMode && (
              <button
                onClick={() => navigate('/dev')}
                className="text-xs font-medium transition-colors"
                style={{ color: 'rgb(var(--accent))' }}
              >
                Open Developer page →
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
