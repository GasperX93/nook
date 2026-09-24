import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useConfig, useUpdateConfig } from '../api/queries'
import LogViewer from '../components/LogViewer'
import { useAppStore } from '../store/app'

export default function Dev() {
  const navigate = useNavigate()
  const { setDevMode } = useAppStore()

  const { data: config, isLoading, isError: configError } = useConfig()
  const updateConfig = useUpdateConfig()
  const [draft, setDraft] = useState<string>('')
  const [editMode, setEditMode] = useState(false)
  const [showSecrets, setShowSecrets] = useState(false)
  const [draftError, setDraftError] = useState<string | null>(null)

  // R5-8: the view shows the whole config (no inner scroll) and masks secrets
  // — Bee's API password was on screen in plain text (screenshot leak risk).
  const isSecret = (key: string) => /password/i.test(key)
  const hasSecrets = Object.keys(config ?? {}).some(isSecret)
  const viewText = config
    ? JSON.stringify(config, (key, value) => (!showSecrets && key && isSecret(key) && value ? '••••••••' : value), 2)
    : 'No config found.'

  function startEdit() {
    setDraft(JSON.stringify(config, null, 2))
    setEditMode(true)
  }

  function save() {
    let parsed: unknown

    try {
      parsed = JSON.parse(draft)
    } catch {
      setDraftError('That isn’t valid JSON — check commas and quotes.')

      return
    }
    setDraftError(null)
    updateConfig.mutate(parsed as Record<string, unknown>, { onSuccess: () => setEditMode(false) })
  }

  return (
    <div className="flex flex-col p-6 gap-6 overflow-auto">
      <div className="flex items-center justify-end shrink-0">
        <button
          onClick={() => {
            setDevMode(false)
            navigate('/settings?tab=network')
          }}
          className="text-xs font-medium transition-colors"
          style={{ color: 'rgb(var(--fg-muted))' }}
        >
          Exit Developer Mode
        </button>
      </div>

      {/* Logs (R4-18) — shared viewer, also at /logs for everyone */}
      <LogViewer className="h-[70vh] shrink-0" />

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
            <div className="flex gap-2">
              {hasSecrets && (
                <button
                  onClick={() => setShowSecrets(v => !v)}
                  className="px-3 py-1.5 rounded text-xs font-semibold uppercase tracking-widest"
                  style={{ color: 'rgb(var(--fg-muted))' }}
                >
                  {showSecrets ? 'Hide password' : 'Show password'}
                </button>
              )}
              <button
                onClick={startEdit}
                disabled={isLoading || !config}
                className="px-3 py-1.5 rounded text-xs font-semibold uppercase tracking-widest transition-opacity disabled:opacity-40"
                style={{ backgroundColor: 'rgb(var(--bg))', border: '1px solid rgb(var(--border))' }}
              >
                Edit
              </button>
            </div>
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
                style={{ backgroundColor: 'rgb(var(--accent))', color: 'rgb(var(--primary-foreground))' }}
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
          <div className="space-y-2">
            <textarea
              className="w-full rounded-lg border p-4 text-xs font-mono focus:outline-none resize-y"
              style={{ backgroundColor: 'rgb(var(--bg))', color: 'rgb(var(--fg))' }}
              rows={Math.max(10, draft.split('\n').length + 1)}
              value={draft}
              onChange={e => setDraft(e.target.value)}
              spellCheck={false}
            />
            {draftError && (
              <p className="text-xs" style={{ color: '#ef4444' }}>
                {draftError}
              </p>
            )}
          </div>
        ) : (
          <pre
            className="text-xs overflow-x-auto rounded-lg border p-4"
            style={{ backgroundColor: 'rgb(var(--bg))', color: 'rgb(var(--fg-muted))' }}
          >
            {viewText}
          </pre>
        )}
      </div>
    </div>
  )
}
