import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useBeeLogs, useConfig, useNookLogs, useUpdateConfig } from '../api/queries'
import { useAppStore } from '../store/app'
import { useDerivedKey } from '../hooks/useDerivedKey'

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
}

function KeyDerivationTest() {
  const { signer, deriving, error, walletConnected, derive, clear } = useDerivedKey()
  const [log, setLog] = useState<string[]>([])

  function addLog(msg: string) {
    setLog(prev => [...prev, `[${new Date().toLocaleTimeString()}] ${msg}`])
  }

  async function handleDerive() {
    addLog('Requesting signature...')
    const result = await derive()

    if (result) {
      addLog(`Derived! Address: ${result.getAddress()}`)
      addLog(`Public key: ${bytesToHex(result.getPublicKey()).slice(0, 32)}...`)
      addLog(`Signing key (first 8): ${bytesToHex(result.getSigningKey()).slice(0, 16)}...`)
      addLog(`Encryption key (first 8): ${bytesToHex(result.getEncryptionKey()).slice(0, 16)}...`)
    } else {
      addLog('Derivation failed or rejected')
    }
  }

  async function handleDeriveAgain() {
    addLog('Deriving again (should match)...')
    const result = await derive()

    if (result) {
      addLog(`Address: ${result.getAddress()}`)
      addLog('Compare with previous — should be identical')
    }
  }

  function handleClear() {
    clear()
    addLog('Signer cleared')
  }

  const btnClass =
    'px-3 py-1.5 rounded text-xs font-semibold uppercase tracking-widest transition-opacity disabled:opacity-40'
  const btnStyle = { backgroundColor: 'rgb(var(--bg))', border: '1px solid rgb(var(--border))' }
  const accentStyle = { backgroundColor: 'rgb(var(--accent))', color: '#fff' }

  return (
    <div className="rounded-xl border p-5 space-y-4 shrink-0" style={{ backgroundColor: 'rgb(var(--bg-surface))' }}>
      <div>
        <p className="text-xs uppercase tracking-widest mb-1" style={{ color: 'rgb(var(--fg-muted))' }}>
          Wallet Key Derivation
        </p>
        <p className="text-xs" style={{ color: 'rgb(var(--fg-muted))' }}>
          Wallet: {walletConnected ? 'Connected' : 'Not connected'} | Signer:{' '}
          {signer ? signer.getAddress().slice(0, 10) + '...' : 'None'}
          {deriving ? ' | Deriving...' : ''}
          {error ? ` | Error: ${error}` : ''}
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        <button onClick={handleDerive} disabled={!walletConnected || deriving} className={btnClass} style={accentStyle}>
          1. Derive Key
        </button>
        <button onClick={handleDeriveAgain} disabled={!signer} className={btnClass} style={btnStyle}>
          2. Derive Again (compare)
        </button>
        <button onClick={handleClear} disabled={!signer} className={btnClass} style={{ color: 'rgb(var(--fg-muted))' }}>
          Clear
        </button>
      </div>

      {log.length > 0 && (
        <div className="rounded-lg border p-3 max-h-48 overflow-auto" style={{ backgroundColor: 'rgb(var(--bg))' }}>
          <pre className="text-xs whitespace-pre-wrap break-all" style={{ color: 'rgb(var(--fg-muted))' }}>
            {log.join('\n')}
          </pre>
        </div>
      )}
    </div>
  )
}

type LogTab = 'bee' | 'desktop'

export default function Dev() {
  const [logTab, setLogTab] = useState<LogTab>('bee')
  const { data: beeLogs } = useBeeLogs()
  const { data: nookLogs } = useNookLogs()
  const bottomRef = useRef<HTMLDivElement>(null)
  const navigate = useNavigate()
  const { setDevMode } = useAppStore()

  const { data: config, isLoading, isError: configError } = useConfig()
  const updateConfig = useUpdateConfig()
  const [draft, setDraft] = useState<string>('')
  const [editMode, setEditMode] = useState(false)

  const logs = logTab === 'bee' ? beeLogs : nookLogs

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

      {/* Logs */}
      <div className="flex flex-col shrink-0">
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
          className="rounded-lg border p-4 overflow-auto max-h-64"
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
          <p className="text-sm" style={{ color: 'rgb(var(--fg-muted))' }}>
            Loading…
          </p>
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

      {/* Key Derivation Test */}
      <KeyDerivationTest />
    </div>
  )
}
