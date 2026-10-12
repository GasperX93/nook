/**
 * Behaviour of the message box shared by Messages and the dev chat preview:
 * it grows with the text, and the formatting buttons / shortcuts put the
 * Markdown symbols in for the writer.
 */
import { useEffect, type KeyboardEvent, type RefObject } from 'react'

import { toggleList, toggleWrap, type DraftEdit } from '../lib/draft-format'

/** Tallest the message box grows before it scrolls: about eight lines. */
export const DRAFT_MAX_HEIGHT = 190

/** Grow the box with what's typed, up to DRAFT_MAX_HEIGHT; shrink back when it's cleared. */
export function useAutoGrow(ref: RefObject<HTMLTextAreaElement | null>, value: string, resetKey?: unknown): void {
  useEffect(() => {
    const el = ref.current

    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight + 2, DRAFT_MAX_HEIGHT)}px`
  }, [ref, value, resetKey])
}

export interface DraftFormatting {
  bold: () => void
  italic: () => void
  code: () => void
  list: () => void
  /** Returns true when the key was a formatting shortcut (and has been handled). */
  onKeyDown: (e: KeyboardEvent<HTMLTextAreaElement>) => boolean
}

export function useDraftFormatting(
  ref: RefObject<HTMLTextAreaElement | null>,
  value: string,
  setValue: (next: string) => void,
): DraftFormatting {
  function apply(edit: (value: string, start: number, end: number) => DraftEdit): void {
    const el = ref.current

    if (!el) return
    const next = edit(value, el.selectionStart, el.selectionEnd)

    setValue(next.value)
    // The selection can only be restored once React has written the new text.
    requestAnimationFrame(() => {
      el.focus()
      el.setSelectionRange(next.selStart, next.selEnd)
    })
  }

  const bold = () => apply((v, s, e) => toggleWrap(v, s, e, '**'))
  const italic = () => apply((v, s, e) => toggleWrap(v, s, e, '*'))
  const code = () => apply((v, s, e) => toggleWrap(v, s, e, '`'))
  const list = () => apply(toggleList)

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>): boolean {
    if (!(e.metaKey || e.ctrlKey) || e.altKey) return false
    const key = e.key.toLowerCase()
    let action: (() => void) | null = null

    if (!e.shiftKey && key === 'b') action = bold
    else if (!e.shiftKey && key === 'i') action = italic
    else if (!e.shiftKey && key === 'e') action = code
    else if (e.shiftKey && (key === '8' || key === '*')) action = list

    if (!action) return false
    e.preventDefault()
    action()

    return true
  }

  return { bold, italic, code, list, onKeyDown }
}
