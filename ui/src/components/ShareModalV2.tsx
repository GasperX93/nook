/**
 * ShareModalV2 — grantee management for ACT-backed shared drives (v2).
 * Replaces the legacy ShareModal for drives created via createSharedDrive().
 * Reuses the existing mailbox.send / registry notification infrastructure.
 */
import { Bee } from '@ethersphere/bee-js'
import { ActClient, rawKeySigner } from '@nook/act-js'
import { secp256k1 } from 'ethereum-cryptography/secp256k1'
import { identity, mailbox, registry } from '@swarm-notify/sdk'
import { Bell, Lock, RefreshCw, Trash2, Users, X } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useWalletClient } from 'wagmi'

import { updateMemberList, type MemberEntry } from '../api/memberList'
import { readLatestEntry, writeEntry } from '../api/driveFeed'
import { deriveWriteKey, encryptWriteKeyForWriter } from '../crypto/drive'
import { buildV2ShareLink, useSharedDrivesV2, type SharedDriveV2 } from '../hooks/useSharedDrives'
import { useMemberList } from '../hooks/useMemberList'
import { useDerivedKey } from '../hooks/useDerivedKey'
import { GNOSIS_CHAIN_ID, REGISTRY_ADDRESS } from '../notify/constants'
import { appendSentDriveShare, loadThreads } from '../notify/messages'
import { createNotifyProvider } from '../notify/provider'
import { loadContacts } from '../notify/storage'
import { toLibraryContact } from '../notify/types'

const BEE_URL = `${window.location.origin}/bee-api`

type DriveRole = 'reader' | 'writer'
type NotifyStatus = 'idle' | 'sending' | 'sent' | 'failed'

interface ShareModalV2Props {
  drive: SharedDriveV2
  onClose: () => void
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

function isEthAddress(s: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(s.trim())
}

export default function ShareModalV2({ drive, onClose }: ShareModalV2Props) {
  const { signer } = useDerivedKey()
  const { data: walletClient } = useWalletClient()
  const { updateDrive } = useSharedDrivesV2()
  const memberList = useMemberList(drive)
  const contacts = useMemo(() => loadContacts(), [])
  const bee = useMemo(() => new Bee(BEE_URL), [])

  const [newAddress, setNewAddress] = useState('')
  const [newRole, setNewRole] = useState<DriveRole>('reader')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notifying, setNotifying] = useState(false)
  const [sendOnChain, setSendOnChain] = useState(false)
  const [notifyStatus, setNotifyStatus] = useState<Record<string, NotifyStatus>>({})
  const [onChainStatus, setOnChainStatus] = useState<Record<string, NotifyStatus>>({})

  const members = memberList?.members ?? []
  const isCreator = drive.myRole === 'creator'

  // Contacts that are current grantees and can be notified
  const notifiableMembers = useMemo(
    () =>
      members
        .filter(m => m.ethAddress.toLowerCase() !== drive.creatorAddress.toLowerCase())
        .map(m => ({ member: m, contact: contacts.find(c => c.id.toLowerCase() === m.ethAddress.toLowerCase()) }))
        .filter((x): x is { member: MemberEntry; contact: NonNullable<(typeof x)['contact']> } => Boolean(x.contact)),
    [members, contacts, drive.creatorAddress],
  )
  const pendingNotify = notifiableMembers.filter(x => notifyStatus[x.contact.id] !== 'sent')

  function writeKeyOwnerAddress(): string {
    if (!drive.writeKey) return ''
    const priv = hexToBytes(drive.writeKey)
    const pub = secp256k1.getPublicKey(priv, false)
    const { keccak_256 } = require('@noble/hashes/sha3')
    const addrBytes = keccak_256(pub.slice(1))

    return '0x' + bytesToHex(addrBytes.slice(-20))
  }

  function pickStamp(): string {
    // Use the first usable stamp — callers may enhance this with a picker
    return drive.cachedHistoryRef ? 'default' : 'default'
  }

  async function resolveToUncompressedPub(ethAddress: string): Promise<Uint8Array> {
    const resolved = await identity.resolve(bee, ethAddress)

    if (!resolved) throw new Error(`Could not resolve identity for ${ethAddress}`)

    return secp256k1.ProjectivePoint.fromHex(resolved.walletPublicKey).toRawBytes(false)
  }

  async function handleGrant() {
    if (!signer || !drive.writeKey) {
      setError('Wallet key required for granting access.')

      return
    }

    if (!isEthAddress(newAddress.trim())) {
      setError('Paste a Nook address (0x… 42 chars).')

      return
    }

    setLoading(true)
    setError(null)
    try {
      const resolved = await identity.resolve(bee, newAddress.trim())

      if (!resolved) {
        setError(`Could not resolve identity for ${newAddress}. They must publish a Nook identity first.`)

        return
      }
      const granteePub = secp256k1.ProjectivePoint.fromHex(resolved.walletPublicKey).toRawBytes(false)
      const actSigner = rawKeySigner(signer.getSigningKey())
      const act = new ActClient({ bee: bee as any, stamp: pickStamp() })

      const { historyRef: newHistoryRef } = await act.patchGrantees(
        { add: [granteePub] },
        { signer: actSigner, historyRef: hexToBytes(drive.cachedHistoryRef!) },
      )

      let writeKeyBlob: Uint8Array | undefined

      if (newRole === 'writer') {
        writeKeyBlob = await encryptWriteKeyForWriter(hexToBytes(drive.writeKey), granteePub)
      }

      const { ref: newMemberListRef } = await updateMemberList({
        bee,
        stamp: pickStamp(),
        drive,
        signer,
        change: {
          add: {
            ethAddress: resolved.ethAddress?.toLowerCase() ?? newAddress.toLowerCase(),
            role: newRole,
            addedAt: Date.now(),
            walletPublicKey: resolved.walletPublicKey,
          },
        },
      })

      const latest = await readLatestEntry({
        bee,
        topicHex: drive.driveFeedTopic,
        ownerAddress: writeKeyOwnerAddress(),
      })
      await writeEntry({
        bee,
        stamp: pickStamp(),
        topicHex: drive.driveFeedTopic,
        writeKeyPriv: hexToBytes(drive.writeKey),
        entry: {
          historyRef: bytesToHex(newHistoryRef),
          encryptedRef: latest?.encryptedRef ?? '',
          memberListRef: bytesToHex(newMemberListRef),
        },
      })

      updateDrive(drive.driveId, {
        cachedHistoryRef: bytesToHex(newHistoryRef),
        cachedMemberListRef: bytesToHex(newMemberListRef),
      })

      setNewAddress('')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to grant access')
    } finally {
      setLoading(false)
    }
  }

  async function handleRevoke(member: MemberEntry) {
    if (!signer || !drive.writeKey) return
    setLoading(true)
    setError(null)
    try {
      const granteePub = await resolveToUncompressedPub(member.ethAddress)
      const actSigner = rawKeySigner(signer.getSigningKey())
      const act = new ActClient({ bee: bee as any, stamp: pickStamp() })

      const { historyRef: newHistoryRef } = await act.patchGrantees(
        { revoke: [granteePub] },
        { signer: actSigner, historyRef: hexToBytes(drive.cachedHistoryRef!) },
      )

      let newDrivePatch: Partial<SharedDriveV2> = { cachedHistoryRef: bytesToHex(newHistoryRef) }

      if (member.role === 'writer') {
        // Rotate writeKey on writer revocation
        const newWk = deriveWriteKey(signer.getSigningKey(), drive.driveId, drive.writeKeyVersion + 1)
        newDrivePatch = { ...newDrivePatch, writeKey: bytesToHex(newWk.privateKey), writeKeyVersion: newWk.version }
      }

      const { ref: newMemberListRef } = await updateMemberList({
        bee,
        stamp: pickStamp(),
        drive,
        signer,
        change: { remove: { ethAddress: member.ethAddress } },
      })

      const writeKeyForEntry = newDrivePatch.writeKey ?? drive.writeKey
      const latest = await readLatestEntry({
        bee,
        topicHex: drive.driveFeedTopic,
        ownerAddress: writeKeyOwnerAddress(),
      })

      // Re-encrypt the manifest ref under the new access key (revocation rotated it)
      const currentManifestRef = await act.decryptRef(hexToBytes(latest!.encryptedRef), {
        signer: actSigner,
        publisherPub: secp256k1.ProjectivePoint.fromHex(drive.walletPublicKey!).toRawBytes(false),
        historyRef: hexToBytes(drive.cachedHistoryRef!),
      })
      const newEncryptedRef = await act.reencryptRef(currentManifestRef, {
        signer: actSigner,
        publisherPub: secp256k1.ProjectivePoint.fromHex(drive.walletPublicKey!).toRawBytes(false),
        historyRef: newHistoryRef,
      })

      await writeEntry({
        bee,
        stamp: pickStamp(),
        topicHex: drive.driveFeedTopic,
        writeKeyPriv: hexToBytes(writeKeyForEntry),
        entry: {
          historyRef: bytesToHex(newHistoryRef),
          encryptedRef: bytesToHex(newEncryptedRef),
          memberListRef: bytesToHex(newMemberListRef),
        },
      })

      updateDrive(drive.driveId, { ...newDrivePatch, cachedMemberListRef: bytesToHex(newMemberListRef) })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to revoke access')
    } finally {
      setLoading(false)
    }
  }

  async function handleNotifyAll() {
    if (!signer || pendingNotify.length === 0) return

    if (sendOnChain && (!walletClient || walletClient.chain?.id !== GNOSIS_CHAIN_ID)) {
      setError(`Switch wallet to Gnosis Chain (id ${GNOSIS_CHAIN_ID}) for on-chain wake-up.`)

      return
    }

    setNotifying(true)
    setError(null)
    const myAddr = signer.getAddress()
    const provider = sendOnChain && walletClient ? createNotifyProvider(walletClient) : null

    for (const { member, contact } of pendingNotify) {
      setNotifyStatus(prev => ({ ...prev, [contact.id]: 'sending' }))
      try {
        const role: DriveRole = member.role === 'writer' ? 'writer' : 'reader'
        const granteePub = secp256k1.ProjectivePoint.fromHex(contact.walletPublicKey).toRawBytes(false)
        const writeKeyBlob =
          role === 'writer' && drive.writeKey
            ? await encryptWriteKeyForWriter(hexToBytes(drive.writeKey), granteePub)
            : undefined
        const link = buildV2ShareLink(drive, role, writeKeyBlob, {
          addr: myAddr,
          walletPublicKey: bytesToHex(signer.getPublicKey()),
        })

        await mailbox.send(
          bee,
          signer.getSigningKey(),
          drive.cachedHistoryRef ?? '',
          signer.getSigningKey(),
          myAddr,
          toLibraryContact(contact),
          {
            subject: `Drive shared: ${drive.name}`,
            body: 'Drive shared. Open Nook to add it.',
            type: 'drive-share',
            driveShareLink: link,
            driveName: drive.name,
            fileCount: 0,
          },
        )

        const threads = loadThreads()
        appendSentDriveShare(threads, contact.id, { driveShareLink: link, driveName: drive.name, fileCount: 0 })
        setNotifyStatus(prev => ({ ...prev, [contact.id]: 'sent' }))
      } catch (e) {
        console.error(`Notify ${contact.nickname} failed:`, e)
        setNotifyStatus(prev => ({ ...prev, [contact.id]: 'failed' }))
      }

      if (provider) {
        setOnChainStatus(prev => ({ ...prev, [contact.id]: 'sending' }))
        try {
          await registry.sendNotification(provider, REGISTRY_ADDRESS, hexToBytes(contact.walletPublicKey), contact.id, {
            sender: signer.getAddress(),
          })
          setOnChainStatus(prev => ({ ...prev, [contact.id]: 'sent' }))
        } catch {
          setOnChainStatus(prev => ({ ...prev, [contact.id]: 'failed' }))
        }
      }
    }
    setNotifying(false)
  }

  return (
    <div
      className="fixed inset-0 flex items-center justify-center z-50"
      style={{ backgroundColor: 'rgba(0,0,0,0.6)' }}
      onClick={onClose}
    >
      <div
        className="rounded-xl border p-6 w-[420px] space-y-5"
        style={{ backgroundColor: 'rgb(var(--bg-surface))' }}
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Lock size={14} style={{ color: 'rgb(var(--accent))' }} />
            <p className="text-sm font-semibold">Share "{drive.name}"</p>
          </div>
          <button onClick={onClose} style={{ color: 'rgb(var(--fg-muted))' }}>
            <X size={16} />
          </button>
        </div>

        {/* Member list */}
        <div>
          <p className="text-xs uppercase tracking-widest mb-2" style={{ color: 'rgb(var(--fg-muted))' }}>
            <Users size={10} className="inline mr-1" />
            People with access
          </p>
          <div
            className="rounded-lg border divide-y max-h-44 overflow-auto"
            style={{ borderColor: 'rgb(var(--border))' }}
          >
            {members.length === 0 ? (
              <p className="text-xs p-3" style={{ color: 'rgb(var(--fg-muted))' }}>
                No members yet.
              </p>
            ) : (
              members.map(m => {
                const isMe =
                  m.ethAddress.toLowerCase() === drive.creatorAddress.toLowerCase() && drive.myRole === 'creator'
                const contact = contacts.find(c => c.id.toLowerCase() === m.ethAddress.toLowerCase())
                const status = contact ? notifyStatus[contact.id] : undefined
                const onChain = contact ? onChainStatus[contact.id] : undefined

                return (
                  <div key={m.ethAddress} className="flex items-center justify-between px-3 py-2 gap-2">
                    <span className="text-xs truncate flex-1" style={{ color: 'rgb(var(--fg-muted))' }}>
                      <span className="font-medium mr-1" style={{ color: 'rgb(var(--fg))' }}>
                        {contact?.nickname ?? `${m.ethAddress.slice(0, 8)}…${m.ethAddress.slice(-4)}`}
                      </span>
                      <span
                        className="text-[10px] px-1.5 py-0.5 rounded mr-1"
                        style={{ backgroundColor: 'rgba(74,222,128,0.1)', color: '#4ade80' }}
                      >
                        {m.role}
                      </span>
                      {isMe && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded" style={{ color: 'rgb(var(--fg-muted))' }}>
                          you
                        </span>
                      )}
                      {status === 'sent' && (
                        <span className="text-[10px] px-1 rounded" style={{ color: '#4ade80' }}>
                          notified
                        </span>
                      )}
                      {onChain === 'sent' && (
                        <span className="text-[10px] px-1 rounded" style={{ color: '#60a5fa' }}>
                          +on-chain
                        </span>
                      )}
                    </span>
                    {isCreator && !isMe && (
                      <button
                        onClick={async () => handleRevoke(m)}
                        disabled={loading}
                        className="shrink-0 transition-colors hover:text-red-400 disabled:opacity-40"
                        style={{ color: 'rgb(var(--fg-muted))' }}
                        title="Revoke access"
                      >
                        <Trash2 size={12} />
                      </button>
                    )}
                  </div>
                )
              })
            )}
          </div>
        </div>

        {/* Add grantee — only creator can manage */}
        {isCreator && (
          <div>
            <p className="text-xs uppercase tracking-widest mb-2" style={{ color: 'rgb(var(--fg-muted))' }}>
              Add someone
            </p>
            <div className="flex gap-2">
              <input
                type="text"
                value={newAddress}
                onChange={e => setNewAddress(e.target.value)}
                placeholder="Nook address (0x…)"
                className="flex-1 rounded-lg border px-3 py-2 text-xs font-mono focus:outline-none"
                style={{ backgroundColor: 'rgb(var(--bg))', color: 'rgb(var(--fg))' }}
              />
              <select
                value={newRole}
                onChange={e => setNewRole(e.target.value as DriveRole)}
                className="rounded-lg border px-2 py-2 text-xs focus:outline-none"
                style={{ backgroundColor: 'rgb(var(--bg))', color: 'rgb(var(--fg))' }}
              >
                <option value="reader">Can view</option>
                <option value="writer">Can edit</option>
              </select>
              <button
                onClick={handleGrant}
                disabled={loading || !newAddress.trim()}
                className="px-3 py-2 rounded-lg text-xs font-semibold disabled:opacity-40 flex items-center gap-1"
                style={{ backgroundColor: 'rgb(var(--accent))', color: '#fff' }}
              >
                {loading ? <RefreshCw size={11} className="animate-spin" /> : null}
                Add
              </button>
            </div>
          </div>
        )}

        {error && (
          <p className="text-xs" style={{ color: '#ef4444' }}>
            {error}
          </p>
        )}

        {/* Notifications */}
        {notifiableMembers.length > 0 && (
          <div className="border-t pt-4 space-y-3" style={{ borderColor: 'rgb(var(--border))' }}>
            <button
              onClick={handleNotifyAll}
              disabled={notifying || pendingNotify.length === 0}
              className="w-full py-2 rounded-lg text-xs font-semibold flex items-center justify-center gap-1.5 disabled:opacity-40 border"
              style={{ backgroundColor: 'rgb(var(--bg))', color: 'rgb(var(--fg))', borderColor: 'rgb(var(--border))' }}
            >
              {notifying ? <RefreshCw size={11} className="animate-spin" /> : <Bell size={11} />}
              {notifying
                ? 'Sending…'
                : pendingNotify.length === 0
                  ? 'All notified'
                  : `Send notification to ${pendingNotify.map(x => x.contact.nickname).join(', ')}`}
            </button>
            <label
              className="flex items-start gap-2 text-[11px] cursor-pointer"
              style={{ color: 'rgb(var(--fg-muted))' }}
            >
              <input
                type="checkbox"
                checked={sendOnChain}
                onChange={e => setSendOnChain(e.target.checked)}
                className="mt-0.5"
              />
              <span>
                Also send on-chain wake-up (~0.001 xDAI) — for recipients who haven&apos;t added you back yet. Requires
                wallet on Gnosis Chain.
              </span>
            </label>
          </div>
        )}

        <p className="text-[10px]" style={{ color: 'rgb(var(--fg-muted))' }}>
          Revoking access prevents future decryption but doesn't affect previously downloaded content.
        </p>
      </div>
    </div>
  )
}
