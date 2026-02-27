import { useEffect, useRef, useState } from 'react'
import { useBeeLogs, useDesktopLogs } from '../api/queries'

type LogTab = 'bee' | 'desktop'

export default function Logs() {
  const [tab, setTab] = useState<LogTab>('bee')
  const { data: beeLogs } = useBeeLogs()
  const { data: desktopLogs } = useDesktopLogs()
  const bottomRef = useRef<HTMLDivElement>(null)

  const logs = tab === 'bee' ? beeLogs : desktopLogs

  // Auto-scroll to bottom when new logs arrive
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [logs])

  return (
    <div className="flex flex-col h-full p-6">
      <div className="flex items-center justify-between mb-4">
        <h1
          className="text-base font-semibold uppercase tracking-widest"
          style={{ color: 'rgb(var(--fg-muted))' }}
        >
          Logs
        </h1>
        <div className="flex gap-1">
          {(['bee', 'desktop'] as LogTab[]).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className="px-3 py-1.5 rounded text-xs font-semibold uppercase tracking-widest transition-colors"
              style={
                tab === t
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
        <pre
          className="text-xs whitespace-pre-wrap break-all"
          style={{ color: 'rgb(var(--fg-muted))' }}
        >
          {logs ?? 'No logs available.'}
        </pre>
        <div ref={bottomRef} />
      </div>
    </div>
  )
}
