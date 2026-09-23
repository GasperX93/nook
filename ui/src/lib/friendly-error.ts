/**
 * One-line, user-facing text for an error that may carry a raw server or
 * native dump (R3-5b / R3b-1b). The deletable-drive engine surfaces its load
 * failures verbatim (e.g. a dlopen "different Team IDs" stack on a signed
 * build) — those get a plain explanation; anything else keeps only its first
 * line, capped, so a stack trace never fills the view.
 */
const ENGINE_LOAD_FAILURE = /dlopen|NODE_MODULE_VERSION|different Team IDs|better[-_]sqlite3|\.node\b/i
const MAX_LENGTH = 160

export function friendlyError(error: unknown, fallback: string): string {
  const raw = error instanceof Error ? error.message : typeof error === 'string' ? error : ''

  if (!raw.trim()) return fallback

  if (ENGINE_LOAD_FAILURE.test(raw)) {
    return "Deletable drives couldn't start on this install. Restart Nook — if it keeps happening, install the latest version."
  }

  const first = raw.split('\n')[0].trim()

  return first.length > MAX_LENGTH ? `${first.slice(0, MAX_LENGTH)}…` : first
}
