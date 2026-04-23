import { useEffect, useState } from 'react'
import { Bee } from '@ethersphere/bee-js'
import { secp256k1 } from 'ethereum-cryptography/secp256k1'
import { fetchMemberList, verifyMemberList, type MemberListDoc } from '../api/memberList'
import type { SharedDriveV2 } from './useSharedDrives'

const BEE_URL = `${window.location.origin}/bee-api`

export function useMemberList(drive: SharedDriveV2): MemberListDoc | null {
  const [doc, setDoc] = useState<MemberListDoc | null>(null)

  useEffect(() => {
    if (!drive.cachedMemberListRef) {
      setDoc(null)

      return
    }

    let cancelled = false
    const bee = new Bee(BEE_URL)

    async function load() {
      const ref = hexToBytes(drive.cachedMemberListRef!)
      const fetched = await fetchMemberList(bee, ref)

      if (cancelled) return

      if (fetched && drive.walletPublicKey) {
        const creatorPub = secp256k1.ProjectivePoint.fromHex(drive.walletPublicKey).toRawBytes(false)

        if (!verifyMemberList(fetched, creatorPub)) {
          console.warn('useMemberList: signature verification failed for drive', drive.driveId)
          setDoc(null)

          return
        }
      }
      setDoc(fetched)
    }

    load().catch(err => {
      if (!cancelled) console.error('useMemberList: fetch failed', err)
    })

    return () => {
      cancelled = true
    }
  }, [drive.cachedMemberListRef, drive.walletPublicKey, drive.driveId])

  return doc
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex
  const out = new Uint8Array(clean.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16)

  return out
}
