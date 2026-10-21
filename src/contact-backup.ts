import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'

import { logger } from './logger'
import { getPath } from './path'

/**
 * Contacts in the app folder (#192). The dashboard keeps contacts in the
 * browser's localStorage, which is per browser and profile: another browser
 * or cleared site data showed an empty contact list. This file per identity
 * survives both. Only addresses, names, feed positions and read marks — no message content
 * (received messages reload from Swarm, sent ones too since #191).
 *
 * The server only stores what the dashboard sends; merging happens there.
 */

const DIR = 'contacts'
const ADDRESS = /^0x[0-9a-f]{40}$/

export interface ContactBackup {
  contacts: unknown[]
  sendCursors: Record<string, number>
  /** Per contact: when the conversation was last read (ms), so restored messages aren't all unread */
  readMarks: Record<string, number>
  /** Per contact: how far their feed to me had been read — a new browser waits for that much (#191) */
  theirNext: Record<string, number>
  myName: string
}

function filePath(address: string): string {
  return getPath(`${DIR}/${address}.json`)
}

export function isBackupAddress(address: string): boolean {
  return ADDRESS.test(address)
}

/** The saved backup for this identity, or null when there is none (or it can't be read). */
export function readContactBackup(address: string): ContactBackup | null {
  const path = filePath(address)

  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as ContactBackup
  } catch (error) {
    logger.warn(`contact-backup: could not read ${address}: ${(error as Error).message}`)

    return null
  }
}

/** Validates the shape, then writes atomically (temp file + rename). */
export function writeContactBackup(address: string, value: unknown): boolean {
  const backup = value as Partial<ContactBackup> | null

  if (
    !backup ||
    !Array.isArray(backup.contacts) ||
    typeof backup.sendCursors !== 'object' ||
    backup.sendCursors === null ||
    typeof backup.myName !== 'string' ||
    (backup.readMarks !== undefined && (typeof backup.readMarks !== 'object' || backup.readMarks === null)) ||
    (backup.theirNext !== undefined && (typeof backup.theirNext !== 'object' || backup.theirNext === null))
  ) {
    return false
  }
  const clean: ContactBackup = {
    contacts: backup.contacts,
    sendCursors: backup.sendCursors,
    readMarks: backup.readMarks ?? {},
    theirNext: backup.theirNext ?? {},
    myName: backup.myName,
  }
  const path = filePath(address)

  mkdirSync(getPath(DIR), { recursive: true })
  writeFileSync(`${path}.tmp`, JSON.stringify(clean, null, 2))
  renameSync(`${path}.tmp`, path)

  return true
}
