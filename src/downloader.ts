import { execSync } from 'child_process'
import { unzip } from 'cross-zip'
import { ensureDir, existsSync, unlinkSync, writeFileSync } from 'fs-extra'
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
}

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

const EXPECTED_BEE_VERSION = '2.7.1'

export function isBeeAssetReady(): boolean {
  return existsSync(getPath(process.platform === 'win32' ? 'bee.exe' : 'bee'))
}

function getInstalledBeeVersion(): string | null {
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
      logger.info(`Bee version mismatch (installed: ${installedVersion}, expected: ${EXPECTED_BEE_VERSION}) — upgrading`)
      force = true
    }
  }

  await ensureAsset(
    `https://github.com/ethersphere/bee/releases/download/v${EXPECTED_BEE_VERSION}/bee-${platformString}-${archString}${suffixString}`,
    `bee${suffixString}`,
    { chmod: process.platform !== 'win32', force },
  )
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
  logger.info(`Downloading to ${finalPath}`)
  await downloadFile(url, finalPath)

  if (finalPath.endsWith('.zip')) {
    logger.info('Extracting...')
    await unzipAsync(finalPath, parsedPath.dir)
    unlinkSync(finalPath)
  }

  if (options.chmod) {
    logger.info('Running chmod +x...')
    try {
      execSync(`chmod +x "${finalPath}"`)
    } catch (error) {
      logger.error(error)
    }
  }

  logger.info('OK')
}

async function downloadFile(url: string, target: string): Promise<void> {
  return fetch(url)
    .then(async x => x.arrayBuffer())
    .then(x => writeFileSync(target, Buffer.from(x)))
}
