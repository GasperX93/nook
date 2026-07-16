import {
  ArrowLeft,
  Clock,
  Copy,
  Download,
  ExternalLink,
  File,
  FolderOpen,
  FolderUp,
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

import { getBeeUrl, type Stamp, depthToBytes } from '../api/bee'
import { serverApi, type ReclaimableDrive, type ReclaimableFile } from '../api/server'

// Reclaimable drives (#99): the server stamps chunks client-side and keeps a
// slot ledger, so deleting a file really frees its capacity. Files come from
// the server ledger, not localStorage. Uploads are direct (every chunk waits
// for a pushsync receipt), so progress here means on-the-network.

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
}: {
  file: ReclaimableFile
  encrypted: boolean
  ttlSeconds?: number
  copied: boolean
  deleting: boolean
  onCopy: () => void
  onDelete: () => void
}) {
  const openUrl = `${getBeeUrl()}/bzz/${file.reference}/`
  const ttlDays = ttlSeconds ? ttlSeconds / 86400 : null
  const urgent = ttlDays !== null && ttlDays <= 7

  return (
    <div className="px-2 py-2 flex items-center gap-3 transition-colors hover:bg-white/[0.02]">
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
        <a
          href={openUrl}
          download={file.name}
          title="Download"
          className="w-6 h-6 flex items-center justify-center rounded transition-colors"
          style={{ color: 'rgb(var(--fg-muted))' }}
        >
          <Download size={12} />
        </a>
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

  function pollJob(uploadId: string) {
    pollRef.current = window.setInterval(async () => {
      try {
        const job = await serverApi.getReclaimableUpload(uploadId)
        setChunks(job.chunksUploaded)

        if (job.status !== 'uploading') {
          if (pollRef.current) window.clearInterval(pollRef.current)
          setUploading(null)

          if (job.status === 'error') setUploadError(job.error ?? 'Upload failed')
          else refreshDrives()
        }
      } catch {
        // transient poll failure — keep polling
      }
    }, 1000)
  }

  async function handleFile(uploadFile: globalThis.File) {
    setUploadError(null)
    setChunks(0)
    setUploading({ name: uploadFile.name, estimate: estimateChunks(uploadFile.size) })
    try {
      const { uploadId } = await serverApi.uploadReclaimableFile(drive.batchId, uploadFile)
      pollJob(uploadId)
    } catch (err) {
      setUploading(null)
      setUploadError(err instanceof Error ? err.message : 'Upload failed')
    }
  }

  async function handleFolder(files: globalThis.File[]) {
    if (files.length === 0) return
    // webkitRelativePath is 'folderName/sub/file.ext' — first segment names the folder
    const folderName = files[0].webkitRelativePath.split('/')[0] || 'folder'
    setUploadError(null)
    setChunks(0)
    setStaging({ name: folderName, done: 0, total: files.length })
    try {
      const { stageId } = await serverApi.createReclaimableStage(drive.batchId)

      for (let i = 0; i < files.length; i++) {
        await serverApi.addFileToReclaimableStage(stageId, files[i].webkitRelativePath || files[i].name, files[i])
        setStaging({ name: folderName, done: i + 1, total: files.length })
      }
      const totalBytes = files.reduce((sum, f) => sum + f.size, 0)
      setStaging(null)
      setUploading({ name: folderName, estimate: estimateChunks(totalBytes) + files.length })
      const { uploadId } = await serverApi.commitReclaimableStage(stageId, folderName)
      pollJob(uploadId)
    } catch (err) {
      setStaging(null)
      setUploading(null)
      setUploadError(err instanceof Error ? err.message : 'Folder upload failed')
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

  return (
    <div className="p-6">
      {/* Breadcrumb — same shape as the classic drive view */}
      <div className="flex items-center gap-2 mb-6">
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

        <div className="flex-1" />

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
          // Non-standard but universal in Chromium (= Electron): lets the
          // picker select a directory, files carry webkitRelativePath.
          {...({ webkitdirectory: '', directory: '' } as Record<string, string>)}
          multiple
          onChange={e => {
            const picked = Array.from(e.target.files ?? [])

            if (picked.length > 0) void handleFolder(picked)
            e.target.value = ''
          }}
        />
        <button
          onClick={() => inputRef.current?.click()}
          disabled={Boolean(uploading) || Boolean(staging)}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold shrink-0 disabled:opacity-40"
          style={{ backgroundColor: 'rgb(var(--accent))', color: 'rgb(var(--primary-foreground))' }}
        >
          <Upload size={12} />
          Upload
        </button>
        <button
          onClick={() => folderInputRef.current?.click()}
          disabled={Boolean(uploading) || Boolean(staging)}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs font-medium shrink-0 disabled:opacity-40"
          style={{ color: 'rgb(var(--fg-muted))' }}
        >
          <FolderUp size={12} />
          Folder
        </button>
      </div>

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

      {drive.files.length === 0 && !uploading && !staging ? (
        <p className="text-xs text-center py-12" style={{ color: 'rgb(var(--fg-muted))' }}>
          No files yet. Files you delete from this drive free their space for new uploads.
        </p>
      ) : (
        <div className="divide-y" style={{ borderColor: 'rgb(var(--border))' }}>
          {drive.files.map(file => (
            <FileRow
              key={file.reference}
              file={file}
              encrypted={drive.encrypted}
              ttlSeconds={stamp?.usable ? stamp.batchTTL : undefined}
              copied={copiedRef === file.reference}
              deleting={deletingRef === file.reference}
              onCopy={() => copyLink(file.reference)}
              onDelete={() => setConfirmDelete(file)}
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
