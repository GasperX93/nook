/**
 * One folder row for every drive type (regular, encrypted, deletable): a card
 * that opens the folder, is a drop target for moving files in, and can be
 * renamed or deleted in place. Folders are Nook's own grouping — renaming or
 * deleting one never changes anything on Swarm.
 */
import { FolderOpen, Pencil, Trash2 } from 'lucide-react'
import React, { useState } from 'react'

/** "0 files", "1 file", "3 files · 1 folder". */
export function folderCountLabel(files: number, folders = 0): string {
  const parts = [`${files} file${files === 1 ? '' : 's'}`]

  if (folders > 0) parts.push(`${folders} folder${folders === 1 ? '' : 's'}`)

  return parts.join(' · ')
}

interface FolderCardProps {
  name: string
  files: number
  folders?: number
  /** A file is being dragged over this folder. */
  highlighted?: boolean
  compact?: boolean
  deleteTitle: string
  onOpen: () => void
  onRename: (name: string) => void
  onDelete: () => void
  onDragOver?: (e: React.DragEvent) => void
  onDragLeave?: (e: React.DragEvent) => void
  onDrop?: (e: React.DragEvent) => void
}

export default function FolderCard({
  name,
  files,
  folders = 0,
  highlighted = false,
  compact = false,
  deleteTitle,
  onOpen,
  onRename,
  onDelete,
  onDragOver,
  onDragLeave,
  onDrop,
}: FolderCardProps) {
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState('')

  function commit() {
    const trimmed = value.trim()

    if (trimmed && trimmed !== name) onRename(trimmed)
    setEditing(false)
  }

  return (
    <div
      onClick={() => {
        if (!editing) onOpen()
      }}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      className={`rounded-lg border px-4 ${compact ? 'py-2' : 'py-2.5'} flex items-center gap-2 cursor-pointer select-none transition-colors`}
      style={{
        backgroundColor: highlighted ? 'rgba(247,104,8,0.08)' : 'rgb(var(--bg-surface))',
        borderColor: highlighted ? 'rgb(var(--accent))' : 'rgb(var(--border))',
        outline: highlighted ? '2px solid rgb(var(--accent))' : 'none',
        outlineOffset: '-2px',
      }}
    >
      <FolderOpen size={13} style={{ color: 'rgb(var(--fg-muted))' }} />
      {editing ? (
        <input
          type="text"
          autoFocus
          value={value}
          onClick={e => e.stopPropagation()}
          onChange={e => setValue(e.target.value)}
          onKeyDown={e => {
            e.stopPropagation()

            if (e.key === 'Enter') commit()

            if (e.key === 'Escape') setEditing(false)
          }}
          onBlur={commit}
          className="flex-1 min-w-0 bg-transparent text-sm focus:outline-none"
          style={{ color: 'rgb(var(--fg))' }}
        />
      ) : (
        <span className="flex-1 min-w-0 text-sm font-medium truncate">{name}</span>
      )}
      <span className="text-xs whitespace-nowrap" style={{ color: 'rgb(var(--fg-muted))' }}>
        {folderCountLabel(files, folders)}
      </span>
      <button
        onClick={e => {
          e.stopPropagation()
          setValue(name)
          setEditing(true)
        }}
        title="Rename"
        className="w-6 h-6 flex items-center justify-center rounded transition-colors"
        style={{ color: 'rgb(var(--fg-muted))' }}
      >
        <Pencil size={11} />
      </button>
      <button
        onClick={e => {
          e.stopPropagation()
          onDelete()
        }}
        title={deleteTitle}
        className="w-6 h-6 flex items-center justify-center rounded hover:text-red-400 transition-colors"
        style={{ color: 'rgb(var(--fg-muted))' }}
      >
        <Trash2 size={11} />
      </button>
    </div>
  )
}
