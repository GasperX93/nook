import { useState } from 'react'
import { useConfig, useUpdateConfig } from '../api/queries'
import { DEFAULT_GATEWAY, useAppStore } from '../store/app'

export default function Settings() {
  const { data: config, isLoading, isError: configError } = useConfig()
  const updateConfig = useUpdateConfig()
  const [draft, setDraft] = useState<string>('')
  const [editMode, setEditMode] = useState(false)

  const { gatewayUrl, setGatewayUrl } = useAppStore()
  const [gatewayDraft, setGatewayDraft] = useState(gatewayUrl)
  const [gatewaySaved, setGatewaySaved] = useState(false)

  function saveGateway() {
    const url = gatewayDraft.trim().replace(/\/$/, '') || DEFAULT_GATEWAY
    setGatewayDraft(url)
    setGatewayUrl(url)
    setGatewaySaved(true)
    setTimeout(() => setGatewaySaved(false), 2000)
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

      {/* Gateway URL */}
      <div className="rounded-xl border p-5 space-y-4" style={{ backgroundColor: 'rgb(var(--bg-surface))' }}>
        <div>
          <p className="text-xs uppercase tracking-widest mb-1" style={{ color: 'rgb(var(--fg-muted))' }}>
            Public gateway
          </p>
          <p className="text-xs" style={{ color: 'rgb(var(--fg-muted))' }}>
            Used for "Open" links when sharing content. Defaults to the official Swarm gateway.
          </p>
        </div>
        <div className="flex gap-3">
          <input
            type="text"
            value={gatewayDraft}
            onChange={e => setGatewayDraft(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && saveGateway()}
            placeholder={DEFAULT_GATEWAY}
            className="flex-1 rounded-lg border px-3 py-2 text-sm font-mono focus:outline-none"
            style={{ backgroundColor: 'rgb(var(--bg))', color: 'rgb(var(--fg))' }}
          />
          <button
            onClick={saveGateway}
            className="px-4 py-2 rounded-lg text-sm font-semibold shrink-0 transition-colors"
            style={{
              backgroundColor: gatewaySaved ? 'rgba(74,222,128,0.15)' : 'rgb(var(--accent))',
              color: gatewaySaved ? '#4ade80' : '#fff',
            }}
          >
            {gatewaySaved ? 'Saved' : 'Save'}
          </button>
        </div>
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
    </div>
  )
}
