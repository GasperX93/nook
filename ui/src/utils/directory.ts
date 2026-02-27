export interface FileEntry {
  path: string  // relative path within the collection (e.g. "js/app.js")
  file: File
}

/**
 * Read a directory that was dragged onto a drop zone.
 * Uses the FileSystem Access API (webkitGetAsEntry), available in Electron and Chrome.
 */
export async function readDroppedDirectory(
  item: DataTransferItem,
): Promise<{ name: string; entries: FileEntry[] }> {
  const entry = item.webkitGetAsEntry()
  if (!entry?.isDirectory) throw new Error('Not a directory')

  const dir = entry as FileSystemDirectoryEntry
  const entries = await readDirEntry(dir, '')
  return { name: dir.name, entries }
}

async function readDirEntry(
  dir: FileSystemDirectoryEntry,
  prefix: string,
): Promise<FileEntry[]> {
  const result: FileEntry[] = []
  const reader = dir.createReader()

  // readEntries returns at most 100 entries per call — loop until exhausted
  let batch: FileSystemEntry[]
  do {
    batch = await new Promise<FileSystemEntry[]>((resolve, reject) =>
      reader.readEntries(resolve, reject),
    )
    for (const entry of batch) {
      const entryPath = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isFile) {
        const file = await new Promise<File>((resolve, reject) =>
          (entry as FileSystemFileEntry).file(resolve, reject),
        )
        result.push({ path: entryPath, file })
      } else if (entry.isDirectory) {
        const sub = await readDirEntry(entry as FileSystemDirectoryEntry, entryPath)
        result.push(...sub)
      }
    }
  } while (batch.length > 0)

  return result
}

/**
 * Convert the FileList from an <input webkitdirectory> to FileEntry[].
 * Each file's webkitRelativePath looks like "foldername/path/to/file.txt".
 * We strip the top-level folder name so paths are relative to the folder root.
 */
export function fileListToEntries(files: FileList): { name: string; entries: FileEntry[] } {
  const arr = Array.from(files)
  if (arr.length === 0) return { name: '', entries: [] }

  const topFolder = arr[0].webkitRelativePath.split('/')[0]
  const prefix = topFolder + '/'

  const entries: FileEntry[] = arr
    .map(file => ({
      path: file.webkitRelativePath.startsWith(prefix)
        ? file.webkitRelativePath.slice(prefix.length)
        : file.webkitRelativePath,
      file,
    }))
    .filter(e => e.path !== '')

  return { name: topFolder, entries }
}

/** Detect the likely index document in a set of entries (for website uploads) */
export function detectIndexDocument(entries: FileEntry[]): string | null {
  const paths = entries.map(e => e.path)
  if (paths.includes('index.html')) return 'index.html'
  if (paths.includes('index.htm')) return 'index.htm'
  return null
}

export function totalSize(entries: FileEntry[]): number {
  return entries.reduce((sum, e) => sum + e.file.size, 0)
}
