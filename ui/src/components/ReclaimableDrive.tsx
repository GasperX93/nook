import {
  ArrowLeft,
  Clock,
  Copy,
  Download,
  ExternalLink,
  File,
  FolderOpen,
  FolderPlus,
  Lock,
  MoreVertical,
  Pencil,
  Recycle,
  RefreshCw,
  Trash2,
  Upload,
} from 'lucide-react'
import React, { useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'

import { beeApi, getBeeUrl, type Stamp, depthToBytes } from '../api/bee'
import { serverApi, type ReclaimableDrive, type ReclaimableFile } from '../api/server'
import { fileListToEntries, readDroppedDirectory, type FileEntry } from '../utils/directory'

// Reclaimable drives (#99): the server stamps chunks client-side and keeps a
// slot ledger, so deleting a file really frees its capacity. Files come from
// the server ledger, not localStorage. Uploads are direct (every chunk waits
// for a pushsync receipt), so progress here means on-the-network.

// Downloads currently in flight, by reference — row state resets on remount
// but the underlying fetch survives navigation, so dedupe lives here (#105).
const inFlightDownloads = new Set<string>()

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`

  if (bytes < 1_048_576) return `${(bytes / 1024).toFixed(1)} KB`

  if (bytes < 1_073_741_824) return `${(bytes / 1_048_576).toFixed(1)} MB`

  return `${(bytes / 1_073_741_824).toFixed(2)} GB`
}

function ttlToDays(seconds: number): string {
  const d = Math.floor(seconds / 86400)

  if (d <= 0) return '<1d'

  if (d < 365) return `${d}d`

  return `${Math.floor(d / 365)}y`
}

function isImageFile(name: string): boolean {
  return /\.(jpe?g|png|gif|webp|svg)$/i.test(name)
}

function usageOf(drive: ReclaimableDrive): { usedBytes: number; capacityBytes: number; pct: number } {
  const usedBytes = (drive.usage?.occupiedSlots ?? 0) * 4096
  const capacityBytes = depthToBytes(drive.depth)
  const pct = Math.min(100, (usedBytes / capacityBytes) * 100)

  return { usedBytes, capacityBytes, pct }
}

// ─── Drive card (root list row) ───────────────────────────────────────────────

export function ReclaimableDriveCard({
  drive,
  stamp,
  customName,
  onOpen,
  onExtend,
  onRename,
}: {
  drive: ReclaimableDrive
  stamp?: Stamp
  customName?: string
  onOpen: () => void
  onExtend: () => void
  onRename: (name: string) => void
}) {
  const [kebabOpen, setKebabOpen] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [renameInput, setRenameInput] = useState('')
  const kebabRef = useRef<HTMLDivElement>(null)
  const { usedBytes, capacityBytes, pct } = usageOf(drive)
  const name = customName || drive.label || `${drive.batchId.slice(0, 8)}…`
  const ttlDays = stamp ? stamp.batchTTL / 86400 : 0
  const isCriticalTtl = Boolean(stamp?.usable) && ttlDays > 0 && ttlDays <= 7
  const needsExtend = Boolean(stamp?.usable) && ((ttlDays > 0 && ttlDays <= 30) || pct >= 100)

  // Close kebab on outside click (same pattern as DriveCard)
  useEffect(() => {
    if (!kebabOpen) return
    const handler = (e: MouseEvent) => {
      if (kebabRef.current && !kebabRef.current.contains(e.target as Node)) setKebabOpen(false)
    }
    document.addEventListener('mousedown', handler)

    return () => document.removeEventListener('mousedown', handler)
  }, [kebabOpen])

  function commitRename() {
    const val = renameInput.trim()

    if (val) onRename(val)
    setRenaming(false)
  }

  return (
    <div className="border-b" style={{ borderColor: 'rgb(var(--border))' }}>
      <div className="px-4 py-3 hover:bg-[rgb(var(--bg-surface))] transition-colors cursor-pointer" onClick={onOpen}>
        {/* Top line: name + pills + actions */}
        <div className="flex items-center gap-2">
          {renaming ? (
            <input
              autoFocus
              value={renameInput}
              onChange={e => setRenameInput(e.target.value)}
              onBlur={commitRename}
              onKeyDown={e => {
                if (e.key === 'Enter') commitRename()

                if (e.key === 'Escape') setRenaming(false)
              }}
              onClick={e => e.stopPropagation()}
              placeholder="Name this drive…"
              className="text-lg font-medium bg-transparent border-b outline-none flex-1 min-w-0"
              style={{ borderColor: 'rgb(var(--accent))', color: 'rgb(var(--fg))' }}
            />
          ) : (
            <span className="inline-flex items-center gap-1.5 min-w-0 group/drivename">
              <span className="text-lg font-medium truncate min-w-0">{name}</span>
              <button
                onClick={e => {
                  e.stopPropagation()
                  setRenameInput(name)
                  setRenaming(true)
                }}
                className="opacity-0 group-hover/drivename:opacity-100 transition-opacity shrink-0"
                style={{ color: 'rgb(var(--fg-muted))' }}
                aria-label={`Rename ${name}`}
              >
                <Pencil size={13} />
              </button>
            </span>
          )}

          {/* Encrypted pill (private, no sharing on reclaimable drives yet) */}
          {drive.encrypted && (
            <span
              className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full font-semibold shrink-0"
              style={{ backgroundColor: '#3b82f6', color: 'white' }}
            >
              <Lock size={12} />
              Encrypted
            </span>
          )}

          {/* Reclaimable pill */}
          <span
            className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full font-medium shrink-0"
            style={{ backgroundColor: 'rgba(74,222,128,0.1)', color: '#4ade80' }}
            title="Deleting files on this drive frees their space for new uploads"
          >
            <Recycle size={11} />
            Deletable · Beta
          </span>

          {/* Confirming pill */}
          {stamp && !stamp.usable && (
            <span
              className="text-[10px] px-2 py-0.5 rounded-full font-semibold uppercase tracking-widest animate-pulse shrink-0"
              style={{ backgroundColor: 'rgba(247,104,8,0.1)', color: 'rgb(var(--accent))' }}
            >
              Confirming…
            </span>
          )}

          {/* Right-side actions */}
          <div className="ml-auto flex items-center gap-2 shrink-0">
            {needsExtend && (
              <button
                onClick={e => {
                  e.stopPropagation()
                  onExtend()
                }}
                className="px-3 py-1.5 rounded-lg border text-xs font-semibold transition-colors hover:bg-white/5"
                style={{ borderColor: 'rgb(var(--border))', color: 'rgb(var(--fg))' }}
              >
                Extend storage
              </button>
            )}
            <div className="relative" ref={kebabRef} onClick={e => e.stopPropagation()}>
              <button
                onClick={() => setKebabOpen(v => !v)}
                className="w-7 h-7 flex items-center justify-center rounded-lg transition-colors hover:bg-white/5"
                style={{ color: 'rgb(var(--fg-muted))' }}
                aria-label="Drive menu"
              >
                <MoreVertical size={14} />
              </button>
              {kebabOpen && (
                <div
                  className="absolute right-0 top-8 z-20 w-40 rounded-lg border py-1"
                  style={{ backgroundColor: 'rgb(var(--bg-surface))', borderColor: 'rgb(var(--border))' }}
                >
                  <button
                    onClick={() => {
                      setKebabOpen(false)
                      onExtend()
                    }}
                    className="flex items-center gap-2 w-full px-3 py-2 text-xs transition-colors hover:bg-white/5"
                    style={{ color: 'rgb(var(--fg))' }}
                  >
                    <Clock size={13} style={{ color: 'rgb(var(--fg-muted))' }} />
                    Extend storage
                  </button>
                  <button
                    onClick={() => {
                      setKebabOpen(false)
                      setRenameInput(name)
                      setRenaming(true)
                    }}
                    className="flex items-center gap-2 w-full px-3 py-2 text-xs transition-colors hover:bg-white/5"
                    style={{ color: 'rgb(var(--fg))' }}
                  >
                    <Pencil size={13} style={{ color: 'rgb(var(--fg-muted))' }} />
                    Rename
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Bottom line: utilization bar + size + days-left pill + items */}
        <div className="flex items-center gap-2 mt-2 text-sm">
          <div
            className="w-32 h-1 rounded-full shrink-0"
            style={{ backgroundColor: 'rgb(var(--border))' }}
            aria-label={`${Math.round(pct)}% used`}
            title="Exact usage from this drive's storage ledger"
          >
            <div
              className="h-1 rounded-full"
              style={{ width: `${pct}%`, backgroundColor: pct >= 100 ? '#ef4444' : 'rgb(var(--fg))' }}
            />
          </div>
          <span style={{ color: pct >= 100 ? '#ef4444' : 'rgb(var(--fg-muted))' }}>
            {usedBytes > 0 ? `${formatBytes(usedBytes)} / ${formatBytes(capacityBytes)}` : formatBytes(capacityBytes)}
          </span>
          {stamp?.usable && (
            <span
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full"
              style={
                isCriticalTtl
                  ? { backgroundColor: 'rgba(239,68,68,0.1)', color: '#ef4444' }
                  : { backgroundColor: 'rgba(255,255,255,0.05)', color: 'rgb(var(--fg-muted))' }
              }
            >
              <Clock size={11} />
              {ttlToDays(stamp.batchTTL)}
            </span>
          )}
          <span style={{ color: 'rgb(var(--border))' }}>|</span>
          <span style={{ color: 'rgb(var(--fg-muted))' }}>
            {drive.files.length === 1 ? '1 file' : `${drive.files.length} files`}
          </span>
        </div>
      </div>
    </div>
  )
}

// ─── Upload plumbing ──────────────────────────────────────────────────────────
// POST returns a job id; the job's chunk count is receipt-confirmed (every
// chunk POST waited for the network), so this single stage IS propagation.

function estimateChunks(size: number): number {
  const dataChunks = Math.ceil(size / 4096)

  // + intermediate tree chunks (~1/128 per level) + single-entry manifest
  return dataChunks + Math.ceil(dataChunks / 128) + 4
}

// ─── File row (mirrors RecordRow) ─────────────────────────────────────────────

function FileRow({
  file,
  encrypted,
  ttlSeconds,
  copied,
  deleting,
  onCopy,
  onDelete,
  onDragStart,
  onDragEnd,
}: {
  file: ReclaimableFile
  encrypted: boolean
  ttlSeconds?: number
  copied: boolean
  deleting: boolean
  onCopy: () => void
  onDelete: () => void
  onDragStart?: () => void
  onDragEnd?: () => void
}) {
  const openUrl = `${getBeeUrl()}/bzz/${file.reference}/`
  const ttlDays = ttlSeconds ? ttlSeconds / 86400 : null
  const urgent = ttlDays !== null && ttlDays <= 7
  const [downloadPct, setDownloadPct] = useState<number | null>(null)
  const [downloadError, setDownloadError] = useState<string | null>(null)

  // The bee URL is a different origin than the dashboard, so an anchor's
  // download attribute is ignored — fetch to a blob and save it instead
  // (same pattern as classic rows). The filename comes from the ledger, so
  // even pre-1.0.1 uploads without manifest Filename metadata save correctly.
  async function handleDownload() {
    // Dedupe across remounts too (#105): row state resets on navigation but
    // the fetch keeps running — a module-level set prevents a duplicate.
    if (downloadPct !== null || inFlightDownloads.has(file.reference)) return

    inFlightDownloads.add(file.reference)
    setDownloadPct(0)
    setDownloadError(null)

    try {
      const blob = await beeApi.downloadFile(file.reference, setDownloadPct)
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = file.name
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      // Delayed revoke: revoking synchronously can abort a large-blob save
      // the browser hasn't started reading yet.
      setTimeout(() => URL.revokeObjectURL(url), 10_000)
    } catch (error) {
      setDownloadError(error instanceof Error ? error.message : 'Download failed')
    } finally {
      inFlightDownloads.delete(file.reference)
      setDownloadPct(null)
    }
  }

  return (
    <div
      draggable={Boolean(onDragStart)}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      className="px-2 py-2 flex items-center gap-3 transition-colors hover:bg-white/[0.02]"
    >
      {/* Type icon or thumbnail */}
      <div
        className="w-6 h-6 rounded overflow-hidden flex items-center justify-center shrink-0"
        style={{ backgroundColor: 'rgb(var(--bg))' }}
      >
        {encrypted ? (
          <Lock size={12} style={{ color: 'rgb(var(--accent))' }} />
        ) : file.kind === 'manifest' ? (
          <FolderOpen size={12} style={{ color: 'rgb(var(--fg-muted))' }} />
        ) : isImageFile(file.name) ? (
          <img
            src={openUrl}
            className="w-full h-full object-cover"
            onError={e => {
              ;(e.target as HTMLImageElement).style.display = 'none'
            }}
            alt=""
          />
        ) : (
          <File size={12} style={{ color: 'rgb(var(--fg-muted))' }} />
        )}
      </div>

      {/* Name — folders are browseable, link them like classic rows */}
      <div className="flex items-center gap-2 flex-1 min-w-0">
        {file.kind === 'manifest' && !encrypted ? (
          <a
            href={openUrl}
            target="_blank"
            rel="noreferrer"
            className="text-xs font-medium truncate hover:underline"
            style={{ color: 'rgb(var(--fg))' }}
          >
            {file.name}
          </a>
        ) : (
          <p className="text-xs font-medium truncate">{file.name}</p>
        )}
      </div>

      {/* Size (approximate — from the ledger's chunk count) */}
      <span
        className="text-xs shrink-0 hidden sm:block w-14 text-right tabular-nums"
        style={{ color: 'rgb(var(--fg-muted))' }}
      >
        ~{formatBytes(file.chunkCount * 4096)}
      </span>

      {/* Expiry (the drive's TTL — all files on a drive expire together) */}
      {ttlSeconds !== undefined && (
        <div className="flex items-center gap-2 shrink-0">
          <div className="h-1 rounded-full overflow-hidden w-24" style={{ backgroundColor: 'rgb(var(--border))' }}>
            <div
              className="h-full rounded-full transition-all"
              style={{
                width: `${Math.max(2, Math.min(100, ((ttlDays ?? 0) / 365) * 100))}%`,
                backgroundColor: urgent ? '#ef4444' : '#4ade80',
              }}
            />
          </div>
          <span
            className="text-[10px] uppercase tracking-widest font-semibold w-16 text-right whitespace-nowrap"
            style={{ color: urgent ? '#ef4444' : 'rgb(var(--fg-muted))' }}
          >
            {ttlToDays(ttlSeconds)} left
          </span>
        </div>
      )}

      {/* Actions */}
      <div className="flex items-center gap-0.5 shrink-0">
        {/* The reference doubles as the decryption key on encrypted drives,
            so link actions are hidden there (same gating as classic rows) */}
        {!encrypted && (
          <button
            onClick={onCopy}
            title="Copy link"
            className="w-6 h-6 flex items-center justify-center rounded transition-colors"
            style={{ color: copied ? '#4ade80' : 'rgb(var(--fg-muted))' }}
          >
            <Copy size={12} />
          </button>
        )}
        {!encrypted && (
          <a
            href={openUrl}
            target="_blank"
            rel="noreferrer"
            title="Open"
            className="w-6 h-6 flex items-center justify-center rounded"
            style={{ color: 'rgb(var(--fg-muted))' }}
          >
            <ExternalLink size={12} />
          </a>
        )}
        {downloadPct !== null ? (
          <span className="text-[10px] tabular-nums px-1" style={{ color: 'rgb(var(--fg-muted))' }}>
            {downloadPct}%
          </span>
        ) : (
          <button
            onClick={() => void handleDownload()}
            title={downloadError ? `${downloadError} — click to retry` : 'Download'}
            className="w-6 h-6 flex items-center justify-center rounded transition-colors"
            style={{ color: downloadError ? '#ef4444' : 'rgb(var(--fg-muted))' }}
          >
            <Download size={12} />
          </button>
        )}
        <button
          onClick={onDelete}
          disabled={deleting}
          title="Delete — frees this file's space"
          className="w-6 h-6 flex items-center justify-center rounded transition-colors hover:text-red-400 disabled:opacity-40"
          style={{ color: 'rgb(var(--fg-muted))' }}
        >
          {deleting ? <RefreshCw size={12} className="animate-spin" /> : <Trash2 size={12} />}
        </button>
      </div>
    </div>
  )
}

// ─── Delete confirmation (house modal style) ─────────────────────────────────

function DeleteFileModal({
  file,
  onConfirm,
  onClose,
}: {
  file: ReclaimableFile
  onConfirm: () => void
  onClose: () => void
}) {
  return (
    <div
      className="fixed inset-0 flex items-center justify-center z-50"
      style={{ backgroundColor: 'rgba(0,0,0,0.6)' }}
      onClick={onClose}
    >
      <div
        className="rounded-xl border p-6 w-96 space-y-4"
        style={{ backgroundColor: 'rgb(var(--bg-surface))' }}
        onClick={e => e.stopPropagation()}
      >
        <p className="text-sm font-semibold">{file.kind === 'manifest' ? 'Delete folder?' : 'Delete file?'}</p>
        <p className="text-sm truncate" style={{ color: 'rgb(var(--fg))' }}>
          {file.name}
        </p>
        <p className="text-xs" style={{ color: 'rgb(var(--fg-muted))' }}>
          This frees ~{formatBytes(file.chunkCount * 4096)} in your drive for new uploads. Copies already stored on the
          network stay readable until they expire — deleting doesn't erase them everywhere.
        </p>
        <div className="flex gap-3">
          <button
            onClick={onClose}
            className="flex-1 py-2 rounded-lg text-sm"
            style={{ color: 'rgb(var(--fg-muted))' }}
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className="flex-1 py-2 rounded-lg text-sm font-semibold"
            style={{ backgroundColor: 'rgba(239,68,68,0.15)', color: '#ef4444' }}
          >
            Delete file
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Drive detail view (mirrors the classic drive view) ──────────────────────

export function ReclaimableDriveView({
  drive,
  stamp,
  customName,
  onBack,
}: {
  drive: ReclaimableDrive
  stamp?: Stamp
  customName?: string
  onBack: () => void
}) {
  const queryClient = useQueryClient()
  const inputRef = useRef<HTMLInputElement>(null)
  const folderInputRef = useRef<HTMLInputElement>(null)
  const [addingFile, setAddingFile] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [openFolderId, setOpenFolderId] = useState<string | null>(null)
  const [creatingFolder, setCreatingFolder] = useState(false)
  const [newFolderName, setNewFolderName] = useState('')
  const [draggingRef, setDraggingRef] = useState<string | null>(null)
  const [dragOverTarget, setDragOverTarget] = useState<string | 'root' | null>(null)
  const [uploading, setUploading] = useState<{ name: string; estimate: number } | null>(null)
  const [staging, setStaging] = useState<{ name: string; done: number; total: number } | null>(null)
  const [chunks, setChunks] = useState(0)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [deletingRef, setDeletingRef] = useState<string | null>(null)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<ReclaimableFile | null>(null)
  const [copiedRef, setCopiedRef] = useState<string | null>(null)
  const pollRef = useRef<number | null>(null)
  const name = customName || drive.label || `${drive.batchId.slice(0, 8)}…`

  useEffect(
    () => () => {
      if (pollRef.current) window.clearInterval(pollRef.current)
    },
    [],
  )

  function refreshDrives() {
    queryClient.invalidateQueries({ queryKey: ['server', 'reclaimable'] })
  }

  function pollJob(uploadId: string, assignFolderId: string | null) {
    pollRef.current = window.setInterval(async () => {
      try {
        const job = await serverApi.getReclaimableUpload(uploadId)
        setChunks(job.chunksUploaded)

        if (job.status !== 'uploading') {
          if (pollRef.current) window.clearInterval(pollRef.current)

          if (job.status === 'error') {
            setUploading(null)
            setUploadError(job.error ?? 'Upload failed')
          } else {
            // Uploaded while a folder was open → it lives there
            if (assignFolderId && job.reference) {
              await serverApi.moveReclaimableFile(drive.batchId, job.reference, assignFolderId).catch(() => undefined)
            }
            // Keep the uploading panel up until the refetched list actually
            // contains the file — dropping it first flashes "No files yet".
            await queryClient.invalidateQueries({ queryKey: ['server', 'reclaimable'] })
            setUploading(null)
          }
        }
      } catch {
        // transient poll failure — keep polling
      }
    }, 1000)
  }

  async function createFolder() {
    const trimmed = newFolderName.trim()
    setCreatingFolder(false)
    setNewFolderName('')

    if (!trimmed) return
    try {
      await serverApi.createReclaimableFolder(drive.batchId, trimmed)
      refreshDrives()
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : 'Could not create the folder')
    }
  }

  async function moveFile(reference: string, folderId: string | null) {
    try {
      await serverApi.moveReclaimableFile(drive.batchId, reference, folderId)
      refreshDrives()
    } catch {
      /* refresh shows the true state either way */
    }
  }

  async function handleFile(uploadFile: globalThis.File) {
    setAddingFile(false)
    setUploadError(null)
    setChunks(0)
    setUploading({ name: uploadFile.name, estimate: estimateChunks(uploadFile.size) })
    try {
      const { uploadId } = await serverApi.uploadReclaimableFile(drive.batchId, uploadFile)
      pollJob(uploadId, openFolderId)
    } catch (err) {
      setUploading(null)
      setUploadError(err instanceof Error ? err.message : 'Upload failed')
    }
  }

  async function handleFolderEntries(folderName: string, entries: FileEntry[]) {
    if (entries.length === 0) return
    setAddingFile(false)
    setUploadError(null)
    setChunks(0)
    setStaging({ name: folderName, done: 0, total: entries.length })
    try {
      const { stageId } = await serverApi.createReclaimableStage(drive.batchId)

      for (let i = 0; i < entries.length; i++) {
        await serverApi.addFileToReclaimableStage(stageId, entries[i].path, entries[i].file)
        setStaging({ name: folderName, done: i + 1, total: entries.length })
      }
      const totalBytes = entries.reduce((sum, e) => sum + e.file.size, 0)
      setStaging(null)
      setUploading({ name: folderName, estimate: estimateChunks(totalBytes) + entries.length })
      const { uploadId } = await serverApi.commitReclaimableStage(stageId, folderName)
      pollJob(uploadId, openFolderId)
    } catch (err) {
      setStaging(null)
      setUploading(null)
      setUploadError(err instanceof Error ? err.message : 'Folder upload failed')
    }
  }

  async function handleDrop(e: React.DragEvent) {
    e.preventDefault()
    setDragging(false)
    const item = e.dataTransfer.items[0]

    if (!item) return
    const fsEntry = item.webkitGetAsEntry?.()

    if (fsEntry?.isDirectory) {
      try {
        const { name: dirName, entries } = await readDroppedDirectory(item)
        void handleFolderEntries(dirName, entries)
      } catch {
        /* ignore */
      }
    } else {
      const dropped = e.dataTransfer.files[0]

      if (dropped) void handleFile(dropped)
    }
  }

  async function handleDelete(reference: string) {
    setDeletingRef(reference)
    setDeleteError(null)
    try {
      await serverApi.deleteReclaimableFile(drive.batchId, reference)
      await queryClient.invalidateQueries({ queryKey: ['server', 'reclaimable'] })
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : 'Could not delete the file')
    } finally {
      setDeletingRef(null)
    }
  }

  function copyLink(reference: string) {
    void navigator.clipboard.writeText(`${getBeeUrl()}/bzz/${reference}/`)
    setCopiedRef(reference)
    setTimeout(() => setCopiedRef(null), 1500)
  }

  const uploadPct = uploading ? Math.min(99, Math.round((chunks / uploading.estimate) * 100)) : 0
  const openFolder = openFolderId ? (drive.folders.find(folder => folder.id === openFolderId) ?? null) : null
  const visibleFiles = drive.files.filter(file => (openFolderId ? file.folderId === openFolderId : !file.folderId))
  const folderCounts = new Map<string, number>()

  for (const file of drive.files) {
    if (file.folderId) folderCounts.set(file.folderId, (folderCounts.get(file.folderId) ?? 0) + 1)
  }

  return (
    <div className="p-6">
      {/* Breadcrumb — same shape as the classic drive view */}
      <div className="flex items-center gap-2 mb-6">
        {openFolder ? (
          <>
            <button
              onClick={() => setOpenFolderId(null)}
              className="flex items-center gap-1.5 text-xs transition-colors"
              style={{ color: 'rgb(var(--fg-muted))' }}
            >
              <ArrowLeft size={13} />
              {name}
            </button>
            <span style={{ color: 'rgb(var(--fg-muted))' }}>/</span>
            <span className="text-sm font-medium truncate">{openFolder.name}</span>
          </>
        ) : (
          <>
            <button
              onClick={onBack}
              className="flex items-center gap-1.5 text-xs transition-colors"
              style={{ color: 'rgb(var(--fg-muted))' }}
            >
              <ArrowLeft size={13} />
              Drive
            </button>
            <span style={{ color: 'rgb(var(--fg-muted))' }}>/</span>
            <span className="text-sm font-medium truncate">{name}</span>
            {drive.encrypted && <Lock size={12} className="shrink-0" style={{ color: 'rgb(var(--fg-muted))' }} />}
            <span
              className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full font-medium shrink-0"
              style={{ backgroundColor: 'rgba(74,222,128,0.1)', color: '#4ade80' }}
              title="Deleting files on this drive frees their space for new uploads"
            >
              <Recycle size={11} />
              Deletable · Beta
            </span>
          </>
        )}

        <div className="flex-1" />

        <button
          onClick={() => setAddingFile(v => !v)}
          disabled={Boolean(uploading) || Boolean(staging)}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold shrink-0 disabled:opacity-40"
          style={{ backgroundColor: 'rgb(var(--accent))', color: 'rgb(var(--primary-foreground))' }}
        >
          <Upload size={12} />
          Upload
        </button>
        {!openFolder && (
          <button
            onClick={() => {
              setCreatingFolder(true)
              setNewFolderName('')
            }}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs font-medium shrink-0"
            style={{ color: 'rgb(var(--fg-muted))' }}
          >
            <FolderPlus size={12} />
            Folder
          </button>
        )}
      </div>

      {/* New folder inline input — same as classic */}
      {creatingFolder && (
        <div
          className="rounded-lg border px-4 py-2.5 flex items-center gap-3 mb-3"
          style={{ backgroundColor: 'rgb(var(--bg-surface))', borderColor: 'rgb(var(--border))' }}
        >
          <FolderPlus size={14} style={{ color: 'rgb(var(--fg-muted))' }} />
          <input
            type="text"
            autoFocus
            value={newFolderName}
            onChange={e => setNewFolderName(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') void createFolder()

              if (e.key === 'Escape') {
                setCreatingFolder(false)
                setNewFolderName('')
              }
            }}
            onBlur={() => void createFolder()}
            placeholder="Folder name…"
            className="flex-1 bg-transparent text-sm focus:outline-none"
            style={{ color: 'rgb(var(--fg))' }}
          />
          <span className="text-xs" style={{ color: 'rgb(var(--fg-muted))' }}>
            Enter to confirm
          </span>
        </div>
      )}

      {/* Upload panel — same drop zone as the classic AddFilePanel */}
      {addingFile && !uploading && !staging && (
        <div className="max-w-xl mb-4 space-y-3">
          <div
            onDragOver={e => {
              e.preventDefault()
              setDragging(true)
            }}
            onDragLeave={e => {
              if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false)
            }}
            onDrop={handleDrop}
            className="rounded-xl border-2 border-dashed transition-colors"
            style={{
              borderColor: dragging ? 'rgb(var(--accent))' : 'rgb(var(--border))',
              backgroundColor: dragging ? 'rgba(247,104,8,0.04)' : 'transparent',
            }}
          >
            <div className="flex flex-col items-center gap-3 py-12 px-6 text-center">
              <Upload size={26} style={{ color: 'rgb(var(--fg-muted))' }} />
              <div>
                <p className="text-sm font-medium" style={{ color: 'rgb(var(--fg))' }}>
                  Drop a file or folder here
                </p>
                <p className="text-xs mt-1" style={{ color: 'rgb(var(--fg-muted))' }}>
                  or click to browse —{' '}
                  <button
                    onClick={() => inputRef.current?.click()}
                    className="underline"
                    style={{ color: 'rgb(var(--fg-muted))' }}
                  >
                    file
                  </button>
                  {' · '}
                  <button
                    onClick={() => folderInputRef.current?.click()}
                    className="underline"
                    style={{ color: 'rgb(var(--fg-muted))' }}
                  >
                    folder
                  </button>
                </p>
              </div>
            </div>
          </div>

          <button onClick={() => setAddingFile(false)} className="text-xs" style={{ color: 'rgb(var(--fg-muted))' }}>
            Cancel
          </button>

          <input
            ref={inputRef}
            type="file"
            className="hidden"
            onChange={e => {
              const picked = e.target.files?.[0]

              if (picked) void handleFile(picked)
              e.target.value = ''
            }}
          />
          <input
            ref={folderInputRef}
            type="file"
            className="hidden"
            // @ts-expect-error — webkitdirectory not in TS types
            webkitdirectory="true"
            onChange={e => {
              if (!e.target.files?.length) return
              const { name: dirName, entries } = fileListToEntries(e.target.files)
              void handleFolderEntries(dirName, entries)
              e.target.value = ''
            }}
          />
        </div>
      )}

      {/* Upload progress — same panel style as the classic upload */}
      {(uploading || staging) && (
        <div
          className="max-w-xl rounded-xl border p-6 mb-4 space-y-3"
          style={{ backgroundColor: 'rgb(var(--bg-surface))', borderColor: 'rgb(var(--border))' }}
        >
          <div className="flex items-center gap-2">
            <RefreshCw size={13} className="animate-spin shrink-0" style={{ color: 'rgb(var(--accent))' }} />
            <p className="text-sm truncate" style={{ color: 'rgb(var(--fg-muted))' }}>
              {staging
                ? `Preparing ${staging.name}… ${staging.done}/${staging.total} files`
                : `Uploading & propagating ${uploading!.name}… · ${chunks} chunks confirmed by the network`}
            </p>
          </div>
          <div className="h-1 rounded-full" style={{ backgroundColor: 'rgb(var(--border))' }}>
            <div
              className="h-1 rounded-full transition-all"
              style={{
                width: `${staging ? Math.round((staging.done / staging.total) * 100) : uploadPct}%`,
                backgroundColor: 'rgb(var(--accent))',
              }}
            />
          </div>
        </div>
      )}

      {(uploadError || deleteError) && (
        <p className="text-xs mb-3" style={{ color: '#ef4444' }}>
          {uploadError || deleteError}
        </p>
      )}

      {/* Folder rows (drive root only) — drop targets for drag-to-move */}
      {!openFolder && drive.folders.length > 0 && (
        <div className="space-y-1 mb-3">
          {drive.folders.map(folder => (
            <div
              key={folder.id}
              onClick={() => setOpenFolderId(folder.id)}
              onDragOver={
                draggingRef
                  ? e => {
                      e.preventDefault()
                      setDragOverTarget(folder.id)
                    }
                  : undefined
              }
              onDragLeave={draggingRef ? () => setDragOverTarget(null) : undefined}
              onDrop={
                draggingRef
                  ? e => {
                      e.preventDefault()
                      void moveFile(draggingRef, folder.id)
                      setDraggingRef(null)
                      setDragOverTarget(null)
                    }
                  : undefined
              }
              className="flex items-center gap-2 px-2 py-1.5 rounded-lg cursor-pointer transition-colors hover:bg-white/[0.03] group/folder"
              style={dragOverTarget === folder.id ? { backgroundColor: 'rgba(247,104,8,0.08)' } : undefined}
            >
              <FolderOpen size={13} style={{ color: 'rgb(var(--fg-muted))' }} />
              <span className="text-xs font-medium flex-1 truncate">{folder.name}</span>
              <span className="text-xs" style={{ color: 'rgb(var(--fg-muted))' }}>
                {folderCounts.get(folder.id) ?? 0} file{(folderCounts.get(folder.id) ?? 0) === 1 ? '' : 's'}
              </span>
              <button
                onClick={e => {
                  e.stopPropagation()
                  void serverApi.deleteReclaimableFolder(drive.batchId, folder.id).then(refreshDrives)
                }}
                title="Remove folder (files move back to the drive)"
                className="w-6 h-6 flex items-center justify-center rounded opacity-0 group-hover/folder:opacity-100 transition-opacity hover:text-red-400"
                style={{ color: 'rgb(var(--fg-muted))' }}
              >
                <Trash2 size={12} />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Move-out drop zone — appears while dragging inside a folder */}
      {openFolder && draggingRef && (
        <div
          onDragOver={e => {
            e.preventDefault()
            setDragOverTarget('root')
          }}
          onDragLeave={() => setDragOverTarget(null)}
          onDrop={e => {
            e.preventDefault()
            void moveFile(draggingRef, null)
            setDraggingRef(null)
            setDragOverTarget(null)
          }}
          className="rounded-lg border-2 border-dashed px-4 py-3 mb-3 text-center text-xs"
          style={{
            borderColor: dragOverTarget === 'root' ? 'rgb(var(--accent))' : 'rgb(var(--border))',
            color: dragOverTarget === 'root' ? 'rgb(var(--accent))' : 'rgb(var(--fg-muted))',
          }}
        >
          Drop here to move out of {openFolder.name}
        </div>
      )}

      {visibleFiles.length === 0 && !uploading && !staging ? (
        <p className="text-xs text-center py-12" style={{ color: 'rgb(var(--fg-muted))' }}>
          {openFolder
            ? 'This folder is empty. Upload here or drag files onto it from the drive.'
            : 'No files yet. Files you delete from this drive free their space for new uploads.'}
        </p>
      ) : (
        <div className="divide-y" style={{ borderColor: 'rgb(var(--border))' }}>
          {visibleFiles.map(file => (
            <FileRow
              key={file.reference}
              file={file}
              encrypted={drive.encrypted}
              ttlSeconds={stamp?.usable ? stamp.batchTTL : undefined}
              copied={copiedRef === file.reference}
              deleting={deletingRef === file.reference}
              onCopy={() => copyLink(file.reference)}
              onDelete={() => setConfirmDelete(file)}
              onDragStart={() => setDraggingRef(file.reference)}
              onDragEnd={() => {
                setDraggingRef(null)
                setDragOverTarget(null)
              }}
            />
          ))}
        </div>
      )}

      {confirmDelete && (
        <DeleteFileModal
          file={confirmDelete}
          onClose={() => setConfirmDelete(null)}
          onConfirm={() => {
            const target = confirmDelete
            setConfirmDelete(null)
            void handleDelete(target.reference)
          }}
        />
      )}
    </div>
  )
}
