import { safeStorage } from 'electron'
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'fs'

import { logger } from './logger'
import { getPath } from './path'

const CACHE_FILE = 'identity-cache.bin'

/**
 * Identity cache — persists the wallet-derived signature across app launches
 * using Electron's safeStorage (OS keychain). The renderer reads/writes
 * through Koa endpoints; this module owns the disk + encryption.
 *
 * On Linux without a desktop keyring, safeStorage.isEncryptionAvailable()
 * returns false. In that case we refuse to persist (the renderer falls back
 * to session-only storage) rather than write plaintext to disk.
 */
export function isIdentityCacheAvailable(): boolean {
  return safeStorage.isEncryptionAvailable()
}

export function readIdentityCache(): string | null {
  if (!isIdentityCacheAvailable()) return null
  const filePath = getPath(CACHE_FILE)
  if (!existsSync(filePath)) return null
  try {
    const encrypted = readFileSync(filePath)

    return safeStorage.decryptString(encrypted)
  } catch (error) {
    logger.warn(`Could not decrypt identity cache: ${(error as Error).message}`)
    // Corrupt blob — remove so we don't keep failing
    try {
      unlinkSync(filePath)
    } catch {
      // ignore
    }

    return null
  }
}

export function writeIdentityCache(value: string): boolean {
  if (!isIdentityCacheAvailable()) return false
  const filePath = getPath(CACHE_FILE)
  try {
    const encrypted = safeStorage.encryptString(value)
    writeFileSync(filePath, encrypted)

    return true
  } catch (error) {
    logger.warn(`Could not write identity cache: ${(error as Error).message}`)

    return false
  }
}

export function clearIdentityCache(): void {
  const filePath = getPath(CACHE_FILE)
  if (!existsSync(filePath)) return
  try {
    unlinkSync(filePath)
  } catch (error) {
    logger.warn(`Could not clear identity cache: ${(error as Error).message}`)
  }
}
