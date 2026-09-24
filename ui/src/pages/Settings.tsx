import { Bell, BellOff, ExternalLink, Moon, Sun } from 'lucide-react'
import { useQuery } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import {
  useAddresses,
  useBeeHealth,
  useConfig,
  useInfo,
  usePeers,
  useRestart,
  useStamps,
  useTopology,
  useUpdateConfig,
} from '../api/queries'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { Switch } from '../components/ui/switch'
import { serverApi } from '../api/server'
import { isSystemStamp } from '../lib/system-stamp'
import { useAppStore } from '../store/app'

type SettingsTab = 'general' | 'network'

/**
 * The backend RPC relay Bee points at in "automatic" mode (src/rpc-endpoints.ts
 * RPC_RELAY_URL): a public RPC with an automatic backup (R5-3/R5-14). Any
 * other URL is the user's own — even one Nook once used as its default: the
 * backend moves those to the relay once at startup, so one still in the
 * config was chosen here (R6-1).
 */
const RPC_RELAY_URL = 'http://127.0.0.1:3054/rpc'

function isAutomaticRpc(value: unknown): boolean {
  return typeof value !== 'string' || value === '' || value === RPC_RELAY_URL
}

export default function Settings() {
  const [searchParams] = useSearchParams()
  const [tab, setTab] = useState<SettingsTab>(() => {
    const t = searchParams.get('tab')

    return t === 'network' ? 'network' : 'general'
  })
  const navigate = useNavigate()

  const { data: config, isLoading, isError: configError } = useConfig()
  const { data: info } = useInfo()
  const { data: updateInfo } = useQuery({
    queryKey: ['server', 'update'],
    queryFn: serverApi.getUpdateInfo,
    refetchInterval: 60 * 60_000,
    retry: false,
  })
  const updateConfig = useUpdateConfig()

  const { data: health } = useBeeHealth()
  const { data: peers } = usePeers()
  const { data: topology } = useTopology()
  const { data: addresses } = useAddresses()

  const [rpcMode, setRpcMode] = useState<'automatic' | 'custom'>('automatic')
  const [rpcDraft, setRpcDraft] = useState('')
  const [rpcError, setRpcError] = useState<string | null>(null)
  const [rpcNeedsRestart, setRpcNeedsRestart] = useState(false)
  const restart = useRestart()
  const { data: stamps, refetch: refetchStamps } = useStamps()

  // A reserve bought while this page is open should appear without a manual
  // reload (fresh-install feedback) — refetch once on mount.
  useEffect(() => {
    void refetchStamps()
    // eslint-disable-next-line
  }, [])
  const systemStamp = (stamps ?? []).find(isSystemStamp)
  const anyDriveUsable = (stamps ?? []).some(st => st.usable && !isSystemStamp(st))
  const [autoRenewOn, setAutoRenewOn] = useState<boolean | null>(null)
  const [renewSaving, setRenewSaving] = useState(false)
  const [confirmingRenewOff, setConfirmingRenewOff] = useState(false)

  useEffect(() => {
    if (!systemStamp) return
    serverApi
      .getAutoExtend()
      .then(r => setAutoRenewOn(Boolean(r.settings[systemStamp.batchID.toLowerCase()]?.enabled)))
      .catch(() => setAutoRenewOn(null))
  }, [systemStamp?.batchID])

  async function setAutoRenew(next: boolean) {
    if (!systemStamp || renewSaving) return
    setRenewSaving(true)
    try {
      await serverApi.setAutoExtend(systemStamp.batchID, next, 3)
      setAutoRenewOn(next)
    } catch {
      // keep old state
    } finally {
      setRenewSaving(false)
      setConfirmingRenewOff(false)
    }
  }

  function toggleAutoRenew() {
    const next = !(autoRenewOn ?? false)

    // Turning OFF gets an inline confirm — expiry here means an unreachable
    // identity and lost unsent messages.
    if (!next && !confirmingRenewOff) {
      setConfirmingRenewOff(true)

      return
    }
    void setAutoRenew(next)
  }

  const { devMode, setDevMode, theme, setTheme, notificationSound, setNotificationSound } = useAppStore()

  // Before funding (ultra-light) Bee deliberately has no RPC configured —
  // Nook's funding monitor uses the automatic connection and sets Bee up when
  // it switches to light mode — so the choice is only offered once funded.
  const nodeFunded = config?.['swap-enable'] === true || config?.['swap-enable'] === 'true'
  const savedRpc = config?.['blockchain-rpc-endpoint']
  const savedMode: 'automatic' | 'custom' = isAutomaticRpc(savedRpc) ? 'automatic' : 'custom'

  useEffect(() => {
    if (config) {
      setRpcMode(savedMode)
      setRpcDraft(savedMode === 'custom' ? (savedRpc as string) : '')
    }
    // eslint-disable-next-line
  }, [config])

  const rpcChanged =
    rpcMode !== savedMode || (rpcMode === 'custom' && rpcDraft.trim() !== ((savedRpc as string | undefined) ?? ''))

  function saveRpc() {
    if (!config) return
    setRpcError(null)
    let url = RPC_RELAY_URL

    if (rpcMode === 'custom') {
      url = rpcDraft.trim()

      if (!/^https?:\/\/\S+$/i.test(url)) {
        setRpcError('Enter a full address starting with https:// (or http://)')

        return
      }
    }
    updateConfig.mutate(
      { ...config, 'blockchain-rpc-endpoint': url },
      {
        onSuccess: () => setRpcNeedsRestart(true),
        onError: () => setRpcError("Couldn't save — is Nook's background service running?"),
      },
    )
  }

  return (
    <div className="p-6 max-w-xl space-y-6">
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
          {/* Identity & messages — the reserved network space (#130) */}
          <div className="rounded-xl border p-5 space-y-3" style={{ backgroundColor: 'rgb(var(--bg-surface))' }}>
            <p className="text-sm mb-1" style={{ color: 'rgb(var(--fg-muted))' }}>
              Identity &amp; messages
            </p>
            {systemStamp ? (
              <>
                <p className="text-xs" style={{ color: 'rgb(var(--fg-muted))' }}>
                  Reserved network space for your name and messages
                  {systemStamp.usable && systemStamp.batchTTL > 0
                    ? ` · ${Math.floor(systemStamp.batchTTL / 86400)} days left`
                    : ' · preparing…'}
                  {autoRenewOn ? ' · renews automatically' : ''}
                </p>
                <div className="flex items-center gap-3">
                  <Switch
                    checked={Boolean(autoRenewOn)}
                    onCheckedChange={toggleAutoRenew}
                    disabled={renewSaving || autoRenewOn === null}
                    aria-label="Renew automatically"
                  />
                  <span className="text-xs" style={{ color: 'rgb(var(--fg))' }}>
                    Renew automatically
                  </span>
                </div>
                {confirmingRenewOff && (
                  <div className="space-y-2">
                    <p className="text-xs" style={{ color: '#f59e0b' }}>
                      Turn off automatic renewal? Without it, new people won't be able to find you and unsent messages
                      may be lost when the space expires.
                    </p>
                    <div className="flex items-center gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => void setAutoRenew(false)}
                        disabled={renewSaving}
                      >
                        Turn off anyway
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => setConfirmingRenewOff(false)}>
                        Keep renewing
                      </Button>
                    </div>
                  </div>
                )}
                {autoRenewOn === false && (
                  <p className="text-xs" style={{ color: '#f59e0b' }}>
                    Without renewal, new people won't be able to find you and unsent messages may be lost when the space
                    expires.
                  </p>
                )}
              </>
            ) : anyDriveUsable ? (
              <p className="text-xs" style={{ color: '#f59e0b' }}>
                Temporarily using space from your drives for messages — Nook will reserve dedicated space automatically
                when your wallet has enough xBZZ (about 3 xBZZ for 3 months).
              </p>
            ) : (
              <p className="text-xs" style={{ color: 'rgb(var(--fg-muted))' }}>
                Nook reserves a small network space for your identity and messages automatically once your node is
                funded.
              </p>
            )}
          </div>

          {/* Appearance */}
          <div className="rounded-xl border p-5 space-y-3" style={{ backgroundColor: 'rgb(var(--bg-surface))' }}>
            <div>
              <p className="text-sm mb-1" style={{ color: 'rgb(var(--fg-muted))' }}>
                Appearance
              </p>
              <p className="text-xs" style={{ color: 'rgb(var(--fg-muted))' }}>
                Toggle between dark and light theme. Light theme is a preview — final polish coming with the redesign.
              </p>
            </div>
            <div className="flex gap-2">
              {(['dark', 'light'] as const).map(t => {
                const active = theme === t
                const Icon = t === 'dark' ? Moon : Sun

                return (
                  <Button key={t} onClick={() => setTheme(t)} variant={active ? 'default' : 'outline'} size="sm">
                    <Icon />
                    {t === 'dark' ? 'Dark' : 'Light'}
                  </Button>
                )
              })}
            </div>
          </div>

          {/* Notifications */}
          <div className="rounded-xl border p-5 space-y-3" style={{ backgroundColor: 'rgb(var(--bg-surface))' }}>
            <div>
              <p className="text-sm mb-1" style={{ color: 'rgb(var(--fg-muted))' }}>
                Notifications
              </p>
              <p className="text-xs" style={{ color: 'rgb(var(--fg-muted))' }}>
                Play a short chirp when a new message arrives. Stays quiet while you're on the Contacts page.
              </p>
            </div>
            <Button
              onClick={() => setNotificationSound(!notificationSound)}
              variant={notificationSound ? 'default' : 'outline'}
              size="sm"
            >
              {notificationSound ? <Bell /> : <BellOff />}
              {notificationSound ? 'Sound on' : 'Sound off'}
            </Button>
          </div>

          {/* Blockchain connection (R5-3/R5-14): automatic = public RPC with
              an automatic backup via Nook's relay; custom = the user's own. */}
          <div className="rounded-xl border p-5 space-y-4" style={{ backgroundColor: 'rgb(var(--bg-surface))' }}>
            <div>
              <p className="text-sm mb-1" style={{ color: 'rgb(var(--fg-muted))' }}>
                Blockchain connection (RPC)
              </p>
              <p className="text-xs" style={{ color: 'rgb(var(--fg-muted))' }}>
                How your node reaches Gnosis Chain — for storage purchases, payments to other nodes and your wallet.
              </p>
            </div>
            {isLoading ? (
              <p className="text-xs" style={{ color: 'rgb(var(--fg-muted))' }}>
                Loading…
              </p>
            ) : configError ? (
              <p className="text-xs" style={{ color: 'rgb(var(--fg-muted))' }}>
                Nook backend not available.
              </p>
            ) : !nodeFunded ? (
              <p className="text-xs" style={{ color: 'rgb(var(--fg-muted))' }}>
                Nook uses the automatic connection until your node wallet is funded. You can choose your own after that.
              </p>
            ) : (
              <div className="space-y-3">
                <label className="flex items-start gap-3 cursor-pointer">
                  <input
                    type="radio"
                    name="rpc-mode"
                    className="mt-1"
                    checked={rpcMode === 'automatic'}
                    onChange={() => {
                      setRpcMode('automatic')
                      setRpcError(null)
                    }}
                  />
                  <span>
                    <span className="text-sm block">Automatic (recommended)</span>
                    <span className="text-xs block" style={{ color: 'rgb(var(--fg-muted))' }}>
                      A public connection, with an automatic backup when it's busy.
                    </span>
                  </span>
                </label>
                <label className="flex items-start gap-3 cursor-pointer">
                  <input
                    type="radio"
                    name="rpc-mode"
                    className="mt-1"
                    checked={rpcMode === 'custom'}
                    onChange={() => {
                      setRpcMode('custom')
                      setRpcError(null)
                    }}
                  />
                  <span className="flex-1 min-w-0">
                    <span className="text-sm block">Your own RPC</span>
                    <span className="text-xs block" style={{ color: 'rgb(var(--fg-muted))' }}>
                      For example from a provider account. Nook uses it as-is, with no backup.
                    </span>
                  </span>
                </label>
                {rpcMode === 'custom' && (
                  <Input
                    value={rpcDraft}
                    onChange={e => {
                      setRpcDraft(e.target.value)
                      setRpcError(null)
                    }}
                    onKeyDown={e => e.key === 'Enter' && saveRpc()}
                    placeholder="https://…"
                    className="font-mono text-xs"
                    aria-label="Your RPC address"
                  />
                )}
                {rpcError && (
                  <p className="text-xs" style={{ color: '#ef4444' }}>
                    {rpcError}
                  </p>
                )}
                {rpcNeedsRestart && !rpcChanged ? (
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-xs" style={{ color: 'rgb(var(--fg-muted))' }}>
                      Saved — restart your node to use it.
                    </p>
                    <Button
                      size="sm"
                      onClick={() => restart.mutate(undefined, { onSuccess: () => setRpcNeedsRestart(false) })}
                      disabled={restart.isPending}
                    >
                      {restart.isPending ? 'Restarting…' : 'Restart node'}
                    </Button>
                  </div>
                ) : (
                  <Button onClick={saveRpc} disabled={updateConfig.isPending || !rpcChanged} size="sm">
                    Save
                  </Button>
                )}
              </div>
            )}
          </div>

          {/* Troubleshooting (R5-9) — the logs page was only reachable from
              error banners and Developer mode. */}
          <div
            className="rounded-xl border p-5 flex items-center justify-between gap-4"
            style={{ backgroundColor: 'rgb(var(--bg-surface))' }}
          >
            <div>
              <p className="text-sm mb-1" style={{ color: 'rgb(var(--fg-muted))' }}>
                Troubleshooting
              </p>
              <p className="text-xs" style={{ color: 'rgb(var(--fg-muted))' }}>
                See what your node and Nook are doing — useful when something doesn’t work.
              </p>
            </div>
            <Button size="sm" variant="secondary" onClick={() => navigate('/logs')}>
              View logs
            </Button>
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
            {/* Update offer (phase 1) — notify + link only; self-update is a
                later phase. The bell rings once per version; this row stays. */}
            {updateInfo?.updateAvailable && updateInfo.url && (
              <div
                className="flex items-center justify-between gap-3 rounded-lg px-3 py-2 text-xs"
                style={{ backgroundColor: 'rgba(247,104,8,0.08)', border: '1px solid rgba(247,104,8,0.25)' }}
              >
                <span style={{ color: 'rgb(var(--fg))' }}>
                  Nook {updateInfo.latest} is available — you're on {updateInfo.current}.
                </span>
                <a
                  href={updateInfo.url}
                  target="_blank"
                  rel="noreferrer"
                  className="shrink-0 font-semibold underline"
                  style={{ color: 'rgb(var(--accent))' }}
                >
                  Download →
                </a>
              </div>
            )}
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
              <p className="text-sm" style={{ color: 'rgb(var(--fg-muted))' }}>
                {label}
              </p>
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
                <p className="text-sm mb-1" style={{ color: 'rgb(var(--fg-muted))' }}>
                  Developer mode
                </p>
                <p className="text-xs" style={{ color: 'rgb(var(--fg-muted))' }}>
                  Shows logs and node configuration.
                </p>
              </div>
              <Switch checked={devMode} onCheckedChange={setDevMode} />
            </div>
            {devMode && (
              <Button onClick={() => navigate('/dev')} variant="link" className="self-start h-auto p-0">
                Open Developer page →
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
