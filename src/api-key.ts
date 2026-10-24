import { timingSafeEqual } from 'crypto'
import { readFileSync, writeFileSync } from 'fs'
import { v4 } from 'uuid'
import { checkPath, getPath } from './path'

const API_KEY_FILE = 'api-key.txt'

export function ensureApiKey(): void {
  if (!checkPath(API_KEY_FILE)) {
    const apiKey = v4()
    writeFileSync(getPath(API_KEY_FILE), apiKey)
  }
}

let cached: string | null = null

export function getApiKey() {
  cached ??= readFileSync(getPath(API_KEY_FILE), 'utf-8')

  return cached
}

/** Compares in constant time — no timing hint about how much of a guess was right. */
export function isApiKey(value: string | undefined): boolean {
  if (typeof value !== 'string') return false
  const given = Buffer.from(value)
  const key = Buffer.from(getApiKey())

  return given.length === key.length && timingSafeEqual(given, key)
}
