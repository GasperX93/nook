import { useEffect, useRef, useState } from 'react'
import { useBeeLogs, useConfig, useDesktopLogs, useUpdateConfig } from '../api/queries'

type LogTab = 'bee' | 'desktop'

export default function Dev() {
  const [logTab, setLogTab] = useState<LogTab>('bee')
  const { data: beeLogs } = useBeeLogs()
  const { data: desktopLogs } = useDesktopLogs()
  const bottomRef = useRef<HTMLDivElement>(null)

  const { data: config, isLoading, isError: configError } = useConfig()
  const updateConfig = useUpdateConfig()
  const [draft, setDraft] = useState<string>('')
  const [editMode, setEditMode] = useState(false)

  const logs = logTab === 'bee' ? beeLogs : desktopLogs

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [logs])

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
    <div className="flex flex-col h-full p-6 gap-6">
      <h1 className="text-base font-semibold uppercase tracking-widest shrink-0" style={{ color: 'rgb(var(--fg-muted))' }}>
        Developer
      </h1>

      {/* Logs */}
      <div className="flex flex-col min-h-0" style={{ flex: 2 }}>
        <div className="flex items-center justify-between mb-3 shrink-0">
          <p className="text-xs uppercase tracking-widest font-semibold" style={{ color: 'rgb(var(--fg-muted))' }}>
            Logs
          </p>
          <div className="flex gap-1">
            {(['bee', 'desktop'] as LogTab[]).map(t => (
              <button
                key={t}
                onClick={() => setLogTab(t)}
                className="px-3 py-1.5 rounded text-xs font-semibold uppercase tracking-widest transition-colors"
                style={
                  logTab === t
                    ? { backgroundColor: 'rgb(var(--accent))', color: '#fff' }
                    : { color: 'rgb(var(--fg-muted))' }
                }
              >
                {t === 'bee' ? 'Bee' : 'Desktop'}
              </button>
            ))}
          </div>
        </div>
        <div
          className="flex-1 rounded-lg border p-4 overflow-auto min-h-0"
          style={{ backgroundColor: 'rgb(var(--bg-surface))' }}
        >
          <pre className="text-xs whitespace-pre-wrap break-all" style={{ color: 'rgb(var(--fg-muted))' }}>
            {logs ?? 'No logs available.'}
          </pre>
          <div ref={bottomRef} />
        </div>
      </div>

      {/* Node config */}
      <div className="rounded-xl border p-5 space-y-4 shrink-0" style={{ backgroundColor: 'rgb(var(--bg-surface))' }}>
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
          <p className="text-sm" style={{ color: 'rgb(var(--fg-muted))' }}>Loading…</p>
        ) : configError ? (
          <p className="text-xs py-1" style={{ color: 'rgb(var(--fg-muted))' }}>
            Nook backend not available. Start the app to configure node settings.
          </p>
        ) : editMode ? (
          <textarea
            className="w-full h-48 rounded-lg border p-4 text-xs font-mono focus:outline-none resize-none"
            style={{ backgroundColor: 'rgb(var(--bg))', color: 'rgb(var(--fg))' }}
            value={draft}
            onChange={e => setDraft(e.target.value)}
            spellCheck={false}
          />
        ) : (
          <pre
            className="text-xs overflow-auto rounded-lg border p-4 max-h-48"
            style={{ backgroundColor: 'rgb(var(--bg))', color: 'rgb(var(--fg-muted))' }}
          >
            {JSON.stringify(config, null, 2) ?? 'No config found.'}
          </pre>
        )}
      </div>
    </div>
  )
}
