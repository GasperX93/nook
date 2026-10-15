/**
 * A small, safe subset of Markdown for chat messages: **bold**, *italic*,
 * `code`, fenced code blocks, "- " bullet lists and clickable web links.
 *
 * Messages come from other people, so this only ever produces a tree of plain
 * tokens (rendered as React elements by MessageBody) — never HTML — and a link
 * token exists only for an http(s) address. Messages stay plain text on the
 * wire; an older Nook just shows the symbols as typed.
 */

export type Inline =
  | { t: 'text'; v: string }
  | { t: 'code'; v: string }
  | { t: 'bold'; c: Inline[] }
  | { t: 'italic'; c: Inline[] }
  | { t: 'link'; href: string }

export type Block = { t: 'p'; c: Inline[] } | { t: 'code'; v: string } | { t: 'list'; items: Inline[][] }

// 1: `code`  2: web address  3/4: **bold**  5/6: *italic*
const INLINE = /(`[^`\n]+`)|(https?:\/\/[^\s<>"'`]+)|(\*\*(?=\S)([^\n]*?\S)\*\*)|(\*(?=[^\s*])([^*\n]*?[^\s*])\*)/g

const WORD = /[\p{L}\p{N}_]/u

/** A web address at the end of a sentence shouldn't swallow the full stop or a closing bracket. */
function trimUrl(url: string): string {
  let end = url.length
  const trailing = () => {
    const ch = url[end - 1]

    return '.,;:!?'.includes(ch) || (ch === ')' && !url.slice(0, end).includes('('))
  }

  while (end > 0 && trailing()) end--

  return url.slice(0, end)
}

function pushText(out: Inline[], v: string): void {
  if (!v) return
  const last = out[out.length - 1]

  if (last?.t === 'text') last.v += v
  else out.push({ t: 'text', v })
}

export function parseInline(text: string): Inline[] {
  const out: Inline[] = []
  const re = new RegExp(INLINE.source, 'g')
  let pos = 0
  let m: RegExpExecArray | null

  while ((m = re.exec(text)) !== null) {
    const start = m.index
    let token: Inline | null = null
    let consumed = m[0].length

    if (m[1]) {
      token = { t: 'code', v: m[1].slice(1, -1) }
    } else if (m[2]) {
      const href = trimUrl(m[2])

      consumed = href.length
      token = { t: 'link', href }
    } else if (m[3]) {
      token = { t: 'bold', c: parseInline(m[4]) }
    } else if (m[5]) {
      // "2*3*4" is arithmetic, not emphasis: the stars must not touch a word on the outside.
      const before = text[start - 1] ?? ''
      const after = text[start + consumed] ?? ''

      if (!WORD.test(before) && !WORD.test(after)) token = { t: 'italic', c: parseInline(m[6]) }
    }

    if (token) {
      pushText(out, text.slice(pos, start))
      out.push(token)
      pos = start + consumed
    } else {
      // Not a token after all — keep the first character as text and look again right after it.
      pushText(out, text.slice(pos, start + 1))
      pos = start + 1
    }
    re.lastIndex = pos
  }
  pushText(out, text.slice(pos))

  return out
}

const FENCE = /^\s*```/
const BULLET = /^\s*[-*]\s+(\S.*)$/

export function parseMessage(text: string): Block[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const blocks: Block[] = []
  let para: string[] = []

  const flush = () => {
    if (para.length) blocks.push({ t: 'p', c: parseInline(para.join('\n')) })
    para = []
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    // An opening fence with no closing one is just text.
    const close = FENCE.test(line) ? lines.findIndex((l, j) => j > i && FENCE.test(l)) : -1

    if (close !== -1) {
      flush()
      blocks.push({ t: 'code', v: lines.slice(i + 1, close).join('\n') })
      i = close
    } else if (BULLET.test(line)) {
      flush()
      const items: Inline[][] = []

      while (i < lines.length && BULLET.test(lines[i])) {
        items.push(parseInline((BULLET.exec(lines[i]) as RegExpExecArray)[1]))
        i++
      }
      i--
      blocks.push({ t: 'list', items })
    } else if (line.trim() === '') {
      flush()
    } else {
      para.push(line)
    }
  }
  flush()

  return blocks
}
