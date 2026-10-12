/**
 * The small row of formatting buttons above the message box. Each one puts
 * the Markdown symbols around the selection (or at the cursor) — see
 * hooks/useDraftFormatting.
 */
import { Bold, ChevronDown, ChevronUp, Code, Italic, List } from 'lucide-react'
import type { ReactNode } from 'react'

import type { DraftFormatting } from '../hooks/useDraftFormatting'

const MOD = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl+'

function ToolButton({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      // Keep the focus (and the selection) in the message box.
      onMouseDown={e => e.preventDefault()}
      onClick={onClick}
      className="h-7 w-7 inline-flex items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
    >
      {children}
    </button>
  )
}

interface Props {
  format: DraftFormatting
  /** The message box is opened to its larger size. */
  expanded: boolean
  onToggleExpand: () => void
}

export default function DraftToolbar({ format, expanded, onToggleExpand }: Props) {
  return (
    <div className="relative flex items-center gap-0.5" role="toolbar" aria-label="Formatting">
      <ToolButton label={`Bold (${MOD}B)`} onClick={format.bold}>
        <Bold size={14} />
      </ToolButton>
      <ToolButton label={`Italic (${MOD}I)`} onClick={format.italic}>
        <Italic size={14} />
      </ToolButton>
      <ToolButton label={`Code (${MOD}E)`} onClick={format.code}>
        <Code size={14} />
      </ToolButton>
      <ToolButton label={`List (${MOD}${MOD === '⌘' ? '⇧' : 'Shift+'}8)`} onClick={format.list}>
        <List size={14} />
      </ToolButton>
      {/* The handle: a chevron centred above the box. Up opens the box to about ten lines, down closes it. */}
      <button
        type="button"
        title={expanded ? 'Make the message box smaller' : 'Make the message box bigger'}
        aria-label={expanded ? 'Make the message box smaller' : 'Make the message box bigger'}
        aria-expanded={expanded}
        onMouseDown={e => e.preventDefault()}
        onClick={onToggleExpand}
        className="absolute left-1/2 -translate-x-1/2 h-7 w-12 inline-flex items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        {expanded ? <ChevronDown size={18} /> : <ChevronUp size={18} />}
      </button>
    </div>
  )
}
