// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../api/server', () => ({ serverApi: { createNotification: vi.fn(async () => undefined) } }))

import { buildShareLink, type SharedDrive } from '../hooks/useSharedDrives'
import { applyDriveMessages, findSharedDriveForLink } from './drive-access'
import type { StoredMessage } from './messages'

// R4-15/16: removal / restore reach "Shared with me" from the mailbox, no sync.

const TOPIC = 'aa'.repeat(32)
const OWNER = 'bb'.repeat(20)
const link = buildShareLink({
  feedTopic: TOPIC,
  feedOwner: OWNER,
  actPublisher: '02' + 'cc'.repeat(32),
  sender: { addr: '0x' + 'dd'.repeat(20), walletPublicKey: '02' + 'ee'.repeat(32) },
})

function store(drives: Partial<SharedDrive>[]) {
  localStorage.setItem('nook-shared-drives', JSON.stringify(drives))
}

function drive(): SharedDrive {
  return JSON.parse(localStorage.getItem('nook-shared-drives') ?? '[]')[0]
}

function msg(kind: StoredMessage['kind'], ts: number): StoredMessage {
  return {
    id: `${kind}-${ts}`,
    counterparty: '0x1',
    ts,
    body: '',
    direction: 'received',
    kind,
    driveShareLink: link,
    driveName: 'encrypted 2',
  }
}

beforeEach(() => {
  localStorage.clear()
  store([{ id: 'd1', name: 'encrypted 2', feedTopic: TOPIC, feedOwner: OWNER }])
})

describe('applyDriveMessages', () => {
  it('finds the shared drive a link points at', () => {
    expect(findSharedDriveForLink(link)?.id).toBe('d1')
  })

  it('marks the drive revoked on access-removed', () => {
    applyDriveMessages([msg('drive-access-removed', 1000)], 'Gasper')
    expect(drive().revokedAt).toBe(1000)
  })

  it('clears the mark and requests a sync on access-restored', () => {
    applyDriveMessages([msg('drive-access-removed', 1000), msg('drive-access-restored', 2000)], 'Gasper')
    expect(drive().revokedAt).toBeUndefined()
    expect(drive().syncRequestedAt).toBe(2000)
  })

  it('an older removal does not undo a newer restore', () => {
    applyDriveMessages([msg('drive-access-restored', 2000)], 'Gasper')
    store([{ ...drive(), revokedAt: 3000 }])
    applyDriveMessages([msg('drive-access-removed', 1000)], 'Gasper')
    expect(drive().revokedAt).toBe(3000)
  })

  it('a plain drive-share for a drive we already have requests a sync', () => {
    applyDriveMessages([msg('drive-share', 5000)], 'Gasper')
    expect(drive().syncRequestedAt).toBe(5000)
  })
})
