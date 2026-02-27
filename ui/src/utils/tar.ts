import type { FileEntry } from './directory'

/**
 * Build a POSIX UStar tar archive from an array of file entries.
 * Used for folder and website uploads to the Bee /bzz endpoint.
 */
export async function createTar(entries: FileEntry[]): Promise<Uint8Array> {
  const blocks: Uint8Array[] = []

  for (const { path, file } of entries) {
    const content = new Uint8Array(await file.arrayBuffer())
    blocks.push(buildHeader(path, content.length))

    // File data must be padded to 512-byte blocks
    const paddedLen = Math.ceil(content.length / 512) * 512
    const padded = new Uint8Array(paddedLen)
    padded.set(content)
    blocks.push(padded)
  }

  // End-of-archive marker: two 512-byte zero blocks
  blocks.push(new Uint8Array(1024))

  const total = blocks.reduce((sum, b) => sum + b.length, 0)
  const result = new Uint8Array(total)
  let offset = 0
  for (const block of blocks) {
    result.set(block, offset)
    offset += block.length
  }
  return result
}

function buildHeader(path: string, size: number): Uint8Array {
  const enc = new TextEncoder()
  const header = new Uint8Array(512) // zero-initialised

  // Split paths longer than 100 chars into name + prefix fields (UStar extension)
  let name = path
  let prefix = ''
  if (path.length > 100) {
    const split = path.lastIndexOf('/', 154)
    if (split > 0 && path.length - split - 1 <= 100) {
      prefix = path.slice(0, split)
      name = path.slice(split + 1)
    } else {
      name = path.slice(path.length - 100)
    }
  }

  const set = (offset: number, str: string) => header.set(enc.encode(str), offset)

  set(0, name)                                                          // name
  set(100, '0000644\0')                                                 // mode
  set(108, '0000000\0')                                                 // uid
  set(116, '0000000\0')                                                 // gid
  set(124, size.toString(8).padStart(11, '0') + '\0')                  // size
  set(136, Math.floor(Date.now() / 1000).toString(8).padStart(11, '0') + '\0') // mtime
  header[156] = 48                                                      // typeflag '0'
  set(257, 'ustar\0')                                                   // magic
  set(263, '00')                                                        // version
  if (prefix) set(345, prefix.slice(0, 154))                           // prefix

  // Checksum: sum all 512 bytes with the checksum field treated as 8 spaces
  header.fill(32, 148, 156)
  let sum = 0
  for (const byte of header) sum += byte
  set(148, sum.toString(8).padStart(6, '0') + '\0 ')                   // checksum

  return header
}
