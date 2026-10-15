/**
 * Behaviour of the message box shared by Messages and the dev chat preview:
 * it grows with the text, and the formatting buttons / shortcuts put the
 * Markdown symbols in for the writer.
 */
import { useEffect, useState, type KeyboardEvent, type RefObject } from 'react'

import { toggleList, toggleWrap, type DraftEdit } from '../lib/draft-format'

/** Tallest the message box grows by itself before it scrolls: about five lines. */
export const DRAFT_MAX_HEIGHT = 130

/** Height of the box once the writer has opened it with the chevron: about ten lines. */
export const DRAFT_EXPANDED_HEIGHT = 220

/**
 * Grow the box with what's typed, up to DRAFT_MAX_HEIGHT; shrink back when
 * it's cleared. When `expanded`, hold it at DRAFT_EXPANDED_HEIGHT instead.
 */
export function useAutoGrow(
  ref: RefObject<HTMLTextAreaElement | null>,
  value: string,
  resetKey?: unknown,
  expanded = false,
): void {
  useEffect(() => {
    const el = ref.current

    if (!el) return

    if (expanded) {
      el.style.maxHeight = 'none'
      el.style.height = `${DRAFT_EXPANDED_HEIGHT}px`

      return
    }
    el.style.maxHeight = `${DRAFT_MAX_HEIGHT}px`
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight + 2, DRAFT_MAX_HEIGHT)}px`
  }, [ref, value, resetKey, expanded])
}

/** The expand button's state. The box goes back to normal once the draft is sent or cleared. */
export function useDraftExpand(value: string): { expanded: boolean; toggle: () => void } {
  const [expanded, setExpanded] = useState(false)

  useEffect(() => {
    if (value === '') setExpanded(false)
  }, [value])

  return { expanded, toggle: () => setExpanded(x => !x) }
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
