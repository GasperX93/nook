import { execSync } from 'child_process'
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
  const archString = Reflect.get(archTable, process.arch)
  const platformString = Reflect.get(platformTable, process.platform)
  const suffixString = process.platform === 'win32' ? '.exe' : ''

  if (!archString || !platformString) {
    throw Error(`Unsupported system: arch=${arch()} platform=${platform()}`)
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
    `https://github.com/ethersphere/bee/releases/download/v${EXPECTED_BEE_VERSION}/bee-${platformString}-${archString}${suffixString}`,
    `bee${suffixString}`,
    { chmod: process.platform !== 'win32', force, minBytes: MIN_BEE_BYTES },
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
    await downloadFile(url, tempPath, options.minBytes ?? 0)
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

async function downloadFile(url: string, target: string, minBytes: number): Promise<void> {
  const response = await fetch(url)

  if (!response.ok) throw new Error(`Couldn't download ${url}: ${response.status} ${response.statusText}`)
  const data = Buffer.from(await response.arrayBuffer())

  if (data.length < minBytes) throw new Error(`Couldn't download ${url}: got only ${data.length} bytes`)
  writeFileSync(target, data)
}
