/**
 * Edits to a message draft made by the formatting buttons and shortcuts:
 * they put the Markdown symbols in for the writer (see lib/message-format for
 * what the symbols turn into). Pure functions over the text and the selection.
 */

export interface DraftEdit {
  value: string
  selStart: number
  selEnd: number
}

function starsBefore(value: string, at: number): number {
  let n = 0

  while (at - n - 1 >= 0 && value[at - n - 1] === '*') n++

  return n
}

function starsAfter(value: string, at: number): number {
  let n = 0

  while (value[at + n] === '*') n++

  return n
}

/** Is the selection already inside this marker? `*` and `**` share a character, so count the stars. */
function isWrapped(value: string, start: number, end: number, marker: string): boolean {
  if (marker === '`') return value[start - 1] === '`' && value[end] === '`'
  const stars = Math.min(starsBefore(value, start), starsAfter(value, end))

  // one star = italic, two = bold, three = both
  return marker === '*' ? stars === 1 || stars === 3 : stars >= 2
}

/**
 * Wrap the selection in a marker (`**`, `*` or a backtick), or take the marker
 * off when it is already there. With nothing selected, the pair is inserted
 * and the cursor lands between the two halves.
 */
export function toggleWrap(value: string, start: number, end: number, marker: string): DraftEdit {
  const n = marker.length

  if (isWrapped(value, start, end, marker)) {
    return {
      value: value.slice(0, start - n) + value.slice(start, end) + value.slice(end + n),
      selStart: start - n,
      selEnd: end - n,
    }
  }

  return {
    value: value.slice(0, start) + marker + value.slice(start, end) + marker + value.slice(end),
    selStart: start + n,
    selEnd: end + n,
  }
}

const BULLET = /^(\s*)[-*]\s+/

/** Turn the lines the selection touches into a "- " list, or back into plain lines. */
export function toggleList(value: string, start: number, end: number): DraftEdit {
  const from = value.lastIndexOf('\n', start - 1) + 1
  const nextBreak = value.indexOf('\n', end)
  const to = nextBreak === -1 ? value.length : nextBreak
  const lines = value.slice(from, to).split('\n')
  const content = lines.filter(l => l.trim() !== '')
  const allBullets = content.length > 0 && content.every(l => BULLET.test(l))
  const changed = lines
    .map(l => {
      if (allBullets) return l.replace(BULLET, '$1')

      return l.trim() === '' && lines.length > 1 ? l : `- ${l}`
    })
    .join('\n')

  return {
    value: value.slice(0, from) + changed + value.slice(to),
    // One line: keep typing at its end. Several: keep them selected.
    selStart: lines.length === 1 ? from + changed.length : from,
    selEnd: from + changed.length,
  }
}
