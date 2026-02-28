import { useEffect, useState } from 'react'
import { useConfig, useUpdateConfig } from '../api/queries'
import { useAppStore } from '../store/app'

const DEFAULT_RPC = 'https://xdai.fairdatasociety.org'

export default function Settings() {
  const { data: config, isLoading, isError: configError } = useConfig()
  const updateConfig = useUpdateConfig()
  const [draft, setDraft] = useState<string>('')
  const [editMode, setEditMode] = useState(false)

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

  function startEdit() {
    setDraft(JSON.stringify(config, null, 2))
    setEditMode(true)
  }

  function save() {
    try {
      const parsed = JSON.parse(draft)
      updateConfig.mutate(parsed, { onSuccess: () => setEditMode(false) })
    } catch {
      // invalid JSON
    }
  }

  return (
    <div className="p-6 max-w-xl space-y-6">
      <h1 className="text-base font-semibold uppercase tracking-widest" style={{ color: 'rgb(var(--fg-muted))' }}>
        Settings
      </h1>

      {/* Developer mode toggle */}
      <div className="rounded-xl border p-5" style={{ backgroundColor: 'rgb(var(--bg-surface))' }}>
        <div className="flex items-center justify-between">
          <div>
            <p className="text-xs uppercase tracking-widest mb-1" style={{ color: 'rgb(var(--fg-muted))' }}>
              Developer mode
            </p>
            <p className="text-xs" style={{ color: 'rgb(var(--fg-muted))' }}>
              Shows logs and node configuration.
            </p>
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
              style={{
                width: 18,
                height: 18,
                left: 2,
                transform: devMode ? 'translateX(18px)' : 'translateX(0)',
              }}
            />
          </button>
        </div>
      </div>

      {/* Developer mode settings */}
      {devMode && (
        <>
          {/* Blockchain RPC URL */}
          <div className="rounded-xl border p-5 space-y-4" style={{ backgroundColor: 'rgb(var(--bg-surface))' }}>
            <div>
              <p className="text-xs uppercase tracking-widest mb-1" style={{ color: 'rgb(var(--fg-muted))' }}>
                Blockchain RPC URL
              </p>
              <p className="text-xs" style={{ color: 'rgb(var(--fg-muted))' }}>
                Gnosis Chain RPC endpoint used for wallet and swap. Defaults to the Fair Data Society node.
              </p>
            </div>
            {isLoading ? (
              <p className="text-xs" style={{ color: 'rgb(var(--fg-muted))' }}>Loading…</p>
            ) : configError ? (
              <p className="text-xs" style={{ color: 'rgb(var(--fg-muted))' }}>
                Nook backend not available.
              </p>
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

          {/* Node config */}
          <div className="rounded-xl border p-5 space-y-4" style={{ backgroundColor: 'rgb(var(--bg-surface))' }}>
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs uppercase tracking-widest mb-1" style={{ color: 'rgb(var(--fg-muted))' }}>
                  Node config
                </p>
                <p className="text-xs" style={{ color: 'rgb(var(--fg-muted))' }}>
                  Advanced Bee node configuration.
                </p>
              </div>
              {!editMode ? (
                <button
                  onClick={startEdit}
                  disabled={isLoading || !config}
                  className="px-3 py-1.5 rounded text-xs font-semibold uppercase tracking-widest transition-opacity disabled:opacity-40"
                  style={{ backgroundColor: 'rgb(var(--bg))', border: '1px solid rgb(var(--border))' }}
                >
                  Edit
                </button>
              ) : (
                <div className="flex gap-2">
                  <button
                    onClick={() => setEditMode(false)}
                    className="px-3 py-1.5 rounded text-xs font-semibold uppercase tracking-widest"
                    style={{ color: 'rgb(var(--fg-muted))' }}
                  >
                    Cancel
                  </button>
                  <button
                    onClick={save}
                    disabled={updateConfig.isPending}
                    className="px-3 py-1.5 rounded text-xs font-semibold uppercase tracking-widest disabled:opacity-40"
                    style={{ backgroundColor: 'rgb(var(--accent))', color: '#fff' }}
                  >
                    {updateConfig.isPending ? 'Saving…' : 'Save'}
                  </button>
                </div>
              )}
            </div>

            {isLoading ? (
              <p className="text-sm" style={{ color: 'rgb(var(--fg-muted))' }}>
                Loading…
              </p>
            ) : configError ? (
              <p className="text-xs py-1" style={{ color: 'rgb(var(--fg-muted))' }}>
                Nook backend not available. Start the app to configure node settings.
              </p>
            ) : editMode ? (
              <textarea
                className="w-full h-[40vh] rounded-lg border p-4 text-xs font-mono focus:outline-none resize-none"
                style={{ backgroundColor: 'rgb(var(--bg))', color: 'rgb(var(--fg))' }}
                value={draft}
                onChange={e => setDraft(e.target.value)}
                spellCheck={false}
              />
            ) : (
              <pre
                className="text-xs overflow-auto rounded-lg border p-4"
                style={{
                  backgroundColor: 'rgb(var(--bg))',
                  color: 'rgb(var(--fg-muted))',
                }}
              >
                {JSON.stringify(config, null, 2) ?? 'No config found.'}
              </pre>
            )}
          </div>
        </>
      )}
    </div>
  )
}
