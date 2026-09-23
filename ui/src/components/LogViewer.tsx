/**
 * Log viewer (R4-18) — used full-size in Developer mode and on the /logs page
 * the error banners link to. Reads the same endpoints as before (whole log
 * file, refreshed every 10 s) and shows the last 2,000 lines, parsed into
 * time · level · message, with search, a "problems only" filter, and Nook's
 * per-request access lines hidden by default (they drown everything else).
 */
import { ArrowDown, Check, Copy, Download, Pause, Play } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'

import { useBeeLogs, useNookLogs } from '../api/queries'
import { isProblem, type LogLevel, type LogLine, parseLog } from '../lib/log-lines'
import { Input } from './ui/input'

type Source = 'bee' | 'nook'

const LINE_LIMIT = 2000

const LEVEL_STYLE: Record<LogLevel, { label: string; color: string }> = {
  error: { label: 'ERROR', color: '#ef4444' },
  warn: { label: 'WARN', color: '#f59e0b' },
  info: { label: 'INFO', color: 'rgb(var(--fg-muted))' },
  debug: { label: 'DEBUG', color: 'rgb(var(--fg-muted))' },
  other: { label: '', color: 'rgb(var(--fg-muted))' },
}

function ToggleChip({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={on}
      className="px-2.5 py-1 rounded-md text-xs border transition-colors"
      style={
        on
          ? {
              backgroundColor: 'rgb(var(--accent))',
              color: 'rgb(var(--primary-foreground))',
              borderColor: 'transparent',
            }
          : { color: 'rgb(var(--fg-muted))', borderColor: 'rgb(var(--border))' }
      }
    >
      {children}
    </button>
  )
}

function Row({ line }: { line: LogLine }) {
  const style = LEVEL_STYLE[line.level]

  if (!line.msg) {
    return (
      <div className="px-3 py-0.5 whitespace-pre-wrap break-all" style={{ color: 'rgb(var(--fg-muted))' }}>
        {line.raw}
      </div>
    )
  }

  return (
    <div
      className="px-3 py-0.5 flex gap-3 items-baseline"
      style={line.level === 'error' ? { backgroundColor: 'rgba(239,68,68,0.06)' } : undefined}
      title={line.raw}
    >
      <span className="shrink-0 tabular-nums" style={{ color: 'rgb(var(--fg-muted))' }}>
        {line.time ?? '        '}
      </span>
      <span className="shrink-0 w-12 font-semibold" style={{ color: style.color }}>
        {style.label}
      </span>
      <span className="min-w-0 break-words" style={{ color: 'rgb(var(--fg))' }}>
        {line.msg}
        {line.logger && (
          <span className="ml-2" style={{ color: 'rgb(var(--fg-muted))' }}>
            {line.logger}
          </span>
        )}
        {line.details && (
          <span className="ml-2 break-all" style={{ color: 'rgb(var(--fg-muted))', opacity: 0.75 }}>
            {line.details}
          </span>
        )}
      </span>
    </div>
  )
}

export default function LogViewer({ className = '' }: { className?: string }) {
  const [source, setSource] = useState<Source>('bee')
  const [query, setQuery] = useState('')
  const [problemsOnly, setProblemsOnly] = useState(false)
  const [showRequests, setShowRequests] = useState(false)
  const [follow, setFollow] = useState(true)
  const [copied, setCopied] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)

  const { data: beeLogs, isError: beeError } = useBeeLogs()
  const { data: nookLogs } = useNookLogs()
  const text = (source === 'bee' ? beeLogs : nookLogs) ?? ''

  const lines = useMemo(() => parseLog(text, LINE_LIMIT), [text])
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()

    return lines.filter(
      l => (showRequests || !l.isAccess) && (!problemsOnly || isProblem(l)) && (!q || l.raw.toLowerCase().includes(q)),
    )
  }, [lines, query, problemsOnly, showRequests])

  // Follow the tail unless the user scrolled up to read.
  useEffect(() => {
    const el = scrollRef.current

    if (follow && el) el.scrollTop = el.scrollHeight
  }, [visible, follow])

  function onScroll() {
    const el = scrollRef.current

    if (!el) return
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24

    if (atBottom !== follow) setFollow(atBottom)
  }

  async function copyVisible() {
    await navigator.clipboard.writeText(visible.map(l => l.raw).join('\n'))
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  function downloadFull() {
    const blob = new Blob([text], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')

    a.href = url
    a.download = `${source === 'bee' ? 'bee' : 'nook'}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.log`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    setTimeout(() => URL.revokeObjectURL(url), 10_000)
  }

  const problemCount = lines.filter(isProblem).length

  return (
    <div className={`flex flex-col gap-3 min-h-0 ${className}`}>
      <div className="flex items-center gap-2 flex-wrap">
        <div className="flex rounded-lg border p-0.5" style={{ borderColor: 'rgb(var(--border))' }}>
          {(['bee', 'nook'] as Source[]).map(s => (
            <button
              key={s}
              type="button"
              onClick={() => setSource(s)}
              className="px-3 py-1 rounded-md text-xs font-medium transition-colors"
              style={
                source === s
                  ? { backgroundColor: 'rgb(var(--bg-surface))', color: 'rgb(var(--fg))' }
                  : { color: 'rgb(var(--fg-muted))' }
              }
            >
              {s === 'bee' ? 'Bee node' : 'Nook app'}
            </button>
          ))}
        </div>
        <Input
          id="log-search"
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="Search logs…"
          className="h-8 w-56 text-xs"
        />
        <ToggleChip on={problemsOnly} onClick={() => setProblemsOnly(v => !v)}>
          Problems only{problemCount > 0 ? ` (${problemCount})` : ''}
        </ToggleChip>
        {source === 'nook' && (
          <ToggleChip on={showRequests} onClick={() => setShowRequests(v => !v)}>
            Show API requests
          </ToggleChip>
        )}
        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            onClick={() => setFollow(v => !v)}
            className="p-1.5 rounded-md hover:bg-white/5"
            title={follow ? 'Pause auto-scroll' : 'Follow new lines'}
            style={{ color: 'rgb(var(--fg-muted))' }}
          >
            {follow ? <Pause size={14} /> : <Play size={14} />}
          </button>
          <button
            type="button"
            onClick={() => void copyVisible()}
            className="p-1.5 rounded-md hover:bg-white/5"
            title="Copy the lines shown"
            style={{ color: 'rgb(var(--fg-muted))' }}
          >
            {copied ? <Check size={14} style={{ color: '#4ade80' }} /> : <Copy size={14} />}
          </button>
          <button
            type="button"
            onClick={downloadFull}
            className="p-1.5 rounded-md hover:bg-white/5"
            title="Download the full log (for bug reports)"
            style={{ color: 'rgb(var(--fg-muted))' }}
          >
            <Download size={14} />
          </button>
        </div>
      </div>

      <div className="relative flex-1 min-h-[24rem]">
        <div
          ref={scrollRef}
          onScroll={onScroll}
          className="absolute inset-0 overflow-auto rounded-lg border py-2 font-mono text-[11px] leading-relaxed"
          style={{ backgroundColor: 'rgb(var(--bg-surface))', borderColor: 'rgb(var(--border))' }}
        >
          {source === 'bee' && beeError ? (
            <p className="px-3" style={{ color: 'rgb(var(--fg-muted))' }}>
              No Bee log yet — the node hasn't written one (is it starting?).
            </p>
          ) : visible.length === 0 ? (
            <p className="px-3" style={{ color: 'rgb(var(--fg-muted))' }}>
              {lines.length === 0 ? 'No logs yet.' : 'Nothing matches these filters.'}
            </p>
          ) : (
            visible.map((l, i) => <Row key={i} line={l} />)
          )}
        </div>
        {!follow && (
          <button
            type="button"
            onClick={() => setFollow(true)}
            className="absolute bottom-3 right-4 flex items-center gap-1 px-3 py-1.5 rounded-full text-xs shadow"
            style={{ backgroundColor: 'rgb(var(--accent))', color: 'rgb(var(--primary-foreground))' }}
          >
            <ArrowDown size={12} />
            Jump to latest
          </button>
        )}
      </div>

      <p className="text-[11px]" style={{ color: 'rgb(var(--fg-muted))' }}>
        Showing the last {LINE_LIMIT.toLocaleString()} lines · refreshes every 10 s · download saves the full log
      </p>
    </div>
  )
}
