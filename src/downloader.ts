import { execSync } from 'child_process'
import { createHash } from 'crypto'
import { unzip } from 'cross-zip'
import { ensureDir, existsSync, removeSync, renameSync, unlinkSync, writeFileSync } from 'fs-extra'
import fetch from 'node-fetch'
import { arch, platform } from 'os'
import { parse } from 'path'
import { promisify } from 'util'
import { logger } from './logger'
import { getPath, paths } from './path'

interface DownloadOptions {
  checkTarget?: string[]
  chmod?: boolean
  force?: boolean
  /** A smaller download is an error page, not the asset. */
  minBytes?: number
  /** The download must have exactly this SHA-256 (hex), or it is thrown away. */
  sha256?: string
}

/** The Bee binary is ~50 MB; anything under this is not it. */
const MIN_BEE_BYTES = 10 * 1024 * 1024

const unzipAsync = promisify(unzip)

const archTable = {
  arm64: 'arm64',
  x64: 'amd64',
}

const platformTable = {
  win32: 'windows',
  darwin: 'darwin',
  linux: 'linux',
}

export const EXPECTED_BEE_VERSION = '2.8.3'

/**
 * SHA-256 of each Bee binary Nook downloads, for EXPECTED_BEE_VERSION. Bee
 * runs next to the wallet, so a download that is not exactly the file checked
 * at release time is refused — the version number alone says nothing about
 * what the file is. An asset with no entry here is not downloaded.
 *
 * On every Bee bump, replace ALL entries: take them from the release's
 * `bee_<version>_checksums.txt` and compare with the asset digests GitHub
 * shows (`gh api repos/ethersphere/bee/releases/tags/v<version>`).
 */
export const BEE_SHA256: Record<string, string> = {
  'bee-darwin-amd64': 'e6dbbfe15e1355e3e97b5042f9bb784c1daca1bb654d407702aeb41cfe9a3756',
  'bee-darwin-arm64': 'd9c21a36fc6c0948422d3e8b9d76ecd2f56b15b1547fa9c0ec9090a74dd1370f',
  'bee-linux-amd64': '716c72933f0845d98dd160f7f60ef99c695d0ca2c2843707976eb45328d42ee9',
  'bee-linux-arm64': '3f016e8f222c9b920ce4d29905d966d7fe91cf16edf5954fde57735464529e08',
  'bee-windows-amd64.exe': 'b21769510368af1c0133a92e1b0e7eef94083b2dbcbb52b35c61815c603b3a29',
}

/** The release asset for this system, e.g. `bee-darwin-arm64`; null when unsupported. */
export function beeAssetName(): string | null {
  const archString = Reflect.get(archTable, process.arch)
  const platformString = Reflect.get(platformTable, process.platform)

  if (!archString || !platformString) return null

  return `bee-${platformString}-${archString}${process.platform === 'win32' ? '.exe' : ''}`
}

export function isBeeAssetReady(): boolean {
  return existsSync(getPath(process.platform === 'win32' ? 'bee.exe' : 'bee'))
}

export function getInstalledBeeVersion(): string | null {
  const beePath = getPath(process.platform === 'win32' ? 'bee.exe' : 'bee')

  if (!existsSync(beePath)) {
    return null
  }

  try {
    const output = execSync(`"${beePath}" version`, { timeout: 5000 }).toString().trim()
    // Output format: "2.7.1-61fab37b" — extract version before the dash
    const version = output.split('-')[0]

    return version || null
  } catch {
    logger.warn('Could not determine installed Bee version')

    return null
  }
}

export async function runDownloader(force = false): Promise<void> {
  const asset = beeAssetName()
  const suffixString = process.platform === 'win32' ? '.exe' : ''

  if (!asset) {
    throw Error(`Unsupported system: arch=${arch()} platform=${platform()}`)
  }
  const sha256 = BEE_SHA256[asset]

  if (!sha256) {
    throw Error(`No checksum for ${asset} ${EXPECTED_BEE_VERSION} — not downloading it`)
  }
  await ensureDir(paths.data)

  // Check if installed Bee version matches expected version
  if (!force) {
    const installedVersion = getInstalledBeeVersion()

    if (installedVersion && installedVersion !== EXPECTED_BEE_VERSION) {
      logger.info(
        `Bee version mismatch (installed: ${installedVersion}, expected: ${EXPECTED_BEE_VERSION}) — upgrading`,
      )
      force = true
    }
  }

  await ensureAsset(
    `https://github.com/ethersphere/bee/releases/download/v${EXPECTED_BEE_VERSION}/${asset}`,
    `bee${suffixString}`,
    { chmod: process.platform !== 'win32', force, minBytes: MIN_BEE_BYTES, sha256 },
  )

  const installed = getInstalledBeeVersion()

  if (installed !== EXPECTED_BEE_VERSION) {
    logger.error(`Bee after download reports version ${installed ?? 'none'} (expected ${EXPECTED_BEE_VERSION})`)
  }
}

async function ensureAsset(url: string, target: string, options: DownloadOptions): Promise<void> {
  logger.info(`Checking asset ${url}`)
  const finalPath = getPath(target)

  const pathsToCheck = options?.checkTarget || [target]

  if (!options.force) {
    const isPresent = pathsToCheck.map(getPath).every(existsSync)

    if (isPresent) {
      logger.info('Skipping, already exists')

      return
    }
  }

  const parsedPath = parse(finalPath)
  // Download next to the target, then rename over it: the old file is only
  // replaced by a complete download, and the new file is a new file. Writing
  // over the binary in place left a Bee macOS killed on every start.
  const tempPath = `${finalPath}.download`

  logger.info(`Downloading to ${finalPath}`)
  try {
    await downloadFile(url, tempPath, options.minBytes ?? 0, options.sha256)
  } catch (error) {
    removeSync(tempPath)
    throw error
  }

  if (options.chmod) {
    logger.info('Running chmod +x...')
    try {
      execSync(`chmod +x "${tempPath}"`)
    } catch (error) {
      logger.error(error)
    }
  }
  renameSync(tempPath, finalPath)

  if (finalPath.endsWith('.zip')) {
    logger.info('Extracting...')
    await unzipAsync(finalPath, parsedPath.dir)
    unlinkSync(finalPath)
  }

  logger.info('OK')
}

async function downloadFile(url: string, target: string, minBytes: number, sha256?: string): Promise<void> {
  const response = await fetch(url)

  if (!response.ok) throw new Error(`Couldn't download ${url}: ${response.status} ${response.statusText}`)
  const data = Buffer.from(await response.arrayBuffer())

  if (data.length < minBytes) throw new Error(`Couldn't download ${url}: got only ${data.length} bytes`)

  if (sha256) {
    const actual = createHash('sha256').update(data).digest('hex')

    // Checked before anything is written: a file that isn't the pinned one never reaches the disk.
    if (actual !== sha256) {
      throw new Error(`Couldn't download ${url}: checksum mismatch (got ${actual}, expected ${sha256})`)
    }
  }
  writeFileSync(target, data)
}
