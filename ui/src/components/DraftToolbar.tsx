/**
 * The small row of formatting buttons above the message box. Each one puts
 * the Markdown symbols around the selection (or at the cursor) — see
 * hooks/useDraftFormatting.
 */
import { Bold, Code, Italic, List, Maximize2, Minimize2 } from 'lucide-react'
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
  /** The message box is expanded to half the window. */
  expanded: boolean
  onToggleExpand: () => void
}

export default function DraftToolbar({ format, expanded, onToggleExpand }: Props) {
  return (
    <div className="flex items-center gap-0.5" role="toolbar" aria-label="Formatting">
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
      <div className="flex-1" />
      <ToolButton
        label={expanded ? 'Make the message box smaller' : 'Make the message box bigger'}
        onClick={onToggleExpand}
      >
        {expanded ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
      </ToolButton>
    </div>
  )
}
