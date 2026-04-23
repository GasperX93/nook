import { useMemo } from 'react'
import { useParams } from 'react-router-dom'
import { useSharedDrivesV2, type SharedDriveV2 } from './useSharedDrives'

export interface ActiveDriveCtx {
  drive: SharedDriveV2 | null
  writeKeyBytes: Uint8Array | null
  canWrite: boolean
}

export function useActiveDrive(): ActiveDriveCtx {
  const { driveId } = useParams<{ driveId: string }>()
  const { drives } = useSharedDrivesV2()

  const drive = useMemo(() => drives.find(d => d.driveId === driveId) ?? null, [drives, driveId])

  const writeKeyBytes = useMemo(() => {
    if (!drive?.writeKey) return null

    return hexToBytes(drive.writeKey)
  }, [drive?.writeKey])

  return {
    drive,
    writeKeyBytes,
    canWrite: drive?.myRole === 'creator' || drive?.myRole === 'writer',
  }
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex
  const out = new Uint8Array(clean.length / 2)
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16)
  }

  return out
}
