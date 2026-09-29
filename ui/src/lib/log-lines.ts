/**
 * Parse Nook / Bee log lines for the log viewer (R4-18).
 *
 * Nook (winston logfmt):  time="2026-…Z" level="info" msg="api access" uri="/status" …
 * Bee:                    "time"="2026-09-23 13:34:51.25" "level"="error" "logger"="node/api/…" "msg"="…" …
 *
 * Anything that doesn't parse is kept as a raw line — the viewer never drops text.
 */
export type LogLevel = 'error' | 'warn' | 'info' | 'debug' | 'other'

export interface LogLine {
  raw: string
  /** HH:MM:SS when a timestamp was found */
  time?: string
  level: LogLevel
  msg?: string
  /** Bee's logger component, e.g. node/api/get_wallet */
  logger?: string
  /** Remaining key=value pairs, compacted */
  details?: string
  /** Nook's per-request access log — noisy, hidden by default */
  isAccess: boolean
}

const PAIR = /"?([\w-]+)"?=("((?:[^"\\]|\\.)*)"|\S+)/g

function toLevel(v: string | undefined): LogLevel {
  switch ((v ?? '').toLowerCase()) {
    case 'error':
    case 'fatal':
      return 'error'
    case 'warn':
    case 'warning':
      return 'warn'
    case 'info':
      return 'info'
    case 'debug':
    case 'trace':
      return 'debug'
    default:
      return 'other'
  }
}

export function parseLogLine(raw: string): LogLine {
  const fields: Record<string, string> = {}
  const rest: string[] = []

  for (const m of raw.matchAll(PAIR)) {
    const key = m[1]
    const value = m[3] ?? m[2]

    if (key in fields) continue
    fields[key] = value

    if (!['time', 'level', 'msg', 'logger'].includes(key)) rest.push(`${key}=${value}`)
  }

  if (!fields.msg && !fields.level) return { raw, level: 'other', isAccess: false }

  const time = /(\d{2}:\d{2}:\d{2})/.exec(fields.time ?? '')?.[1]

  return {
    raw,
    time,
    level: toLevel(fields.level),
    msg: fields.msg,
    logger: fields.logger,
    details: rest.length ? rest.join(' ') : undefined,
    isAccess: fields.msg === 'api access',
  }
}

/** Parse the last `limit` non-empty lines of a log dump. */
export function parseLog(text: string, limit = 2000): LogLine[] {
  const lines = text.split('\n').filter(l => l.trim() !== '')

  return lines.slice(-limit).map(parseLogLine)
}

export function isProblem(line: LogLine): boolean {
  return line.level === 'error' || line.level === 'warn'
}
