/**
 * Background inbox polling — runs at the Layout level so messages keep
 * arriving (and the unread badge updates) even when the Messages page
 * isn't mounted.
 *
 * Side-effect only: fetches new messages from each contact's mailbox feed,
 * merges them into the localStorage threads store. Components reading
 * threads from localStorage (Messages page, Layout badge) pick up the
 * changes on their next render or interval tick.
 *
 * Also auto-adds v2 shared drives when a drive-share message arrives with
 * a driveId in the link, so grantees don't need to manually click "Add drive".
 */
import { Bee } from '@ethersphere/bee-js'
import { mailbox } from '@swarm-notify/sdk'
import { useEffect, useMemo } from 'react'

import { loadThreads, mergeReceived, saveThreads } from '../notify/messages'
import { loadContacts } from '../notify/storage'
import { toLibraryContact } from '../notify/types'
import { decryptWriteKey } from '../crypto/drive'
import { parseShareLinkTyped, type SharedDriveV2 } from './useSharedDrives'
import { useDerivedKey } from './useDerivedKey'

const BEE_URL = `${window.location.origin}/bee-api`
const POLL_INTERVAL_MS = 30_000
const V2_DRIVES_KEY = 'nook-shared-drives-v2'

/** Load v2 drive IDs directly from localStorage (no React state needed). */
function loadKnownDriveIds(): Set<string> {
  try {
    const stored = JSON.parse(localStorage.getItem(V2_DRIVES_KEY) ?? '[]') as Array<{ driveId: string }>
    return new Set(stored.map(d => d.driveId))
  } catch {
    return new Set()
  }
}

/** Persist a new v2 drive directly to localStorage (bypasses React state). */
function persistNewDrive(drive: SharedDriveV2): void {
  try {
    const existing = JSON.parse(localStorage.getItem(V2_DRIVES_KEY) ?? '[]') as SharedDriveV2[]
    if (existing.some(d => d.driveId === drive.driveId)) return
    localStorage.setItem(V2_DRIVES_KEY, JSON.stringify([...existing, drive]))
  } catch {
    // non-fatal
  }
}

export function useInboxPolling(): void {
  const { signer } = useDerivedKey()
  const bee = useMemo(() => new Bee(BEE_URL), [])

  useEffect(() => {
    if (!signer) return

    let cancelled = false

    const poll = async () => {
      const myAddr = signer.getAddress()
      // Re-read contacts each tick — the user may add a contact between polls.
      // Filter out self: if a user adds their own share link as a contact (eg
      // for solo testing), every poll otherwise hits myAddr→myAddr (404).
      const contacts = loadContacts().filter(c => c.id.toLowerCase() !== myAddr.toLowerCase())

      if (contacts.length === 0) return

      try {
        const inbox = await mailbox.checkInbox(bee, signer.getSigningKey(), myAddr, contacts.map(toLibraryContact))

        if (cancelled) return
        // Merge directly into stored threads so the on-disk view is the
        // source of truth for both Messages and the sidebar badge.
        let threads = loadThreads()

        for (const { contact, messages } of inbox) {
          threads = mergeReceived(threads, contact.ethAddress, messages)
        }
        // mergeReceived already persists per call, but call once more here
        // for clarity in case the loop body ever changes.
        saveThreads(threads)

        // Auto-add v2 shared drives from incoming drive-share messages
        const knownIds = loadKnownDriveIds()
        for (const { messages } of inbox) {
          for (const msg of messages) {
            if (msg.type !== 'drive-share' || !msg.driveShareLink) continue
            const parsed = parseShareLinkTyped(msg.driveShareLink)
            if (!parsed || parsed.type !== 'nook-drive-share-v2') continue
            if (knownIds.has(parsed.driveId)) continue

            let writeKeyHex: string | undefined
            if (parsed.writeKeyBlob && parsed.role === 'writer') {
              try {
                const wkBytes = await decryptWriteKey(hexToBytes(parsed.writeKeyBlob), signer.getSigningKey())
                writeKeyHex = bytesToHex(wkBytes)
              } catch {
                // Decryption failed — add as reader rather than dropping the drive
              }
            }

            const drive: SharedDriveV2 = {
              driveId: parsed.driveId,
              name: parsed.name,
              creatorAddress: parsed.creatorAddress,
              myRole: writeKeyHex ? 'writer' : 'reader',
              writeKey: writeKeyHex,
              writeKeyVersion: parsed.writeKeyVersion,
              walletPublicKey: parsed.walletPublicKey,
              driveFeedTopic: parsed.driveFeedTopic,
              addedAt: Date.now(),
            }
            persistNewDrive(drive)
            knownIds.add(parsed.driveId) // deduplicate within this tick
          }
        }
      } catch {
        // Network blips happen; the next tick will retry. Don't spam the UI.
      }
    }

    void poll()
    const id = setInterval(() => void poll(), POLL_INTERVAL_MS)

    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [signer, bee])
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex
  const out = new Uint8Array(clean.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16)
  return out
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
}
