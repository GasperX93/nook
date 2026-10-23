// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from 'vitest'

const sendDriveOps = vi.hoisted(() => vi.fn())

vi.mock('../store/drive-data', async importOriginal => ({
  ...(await importOriginal<typeof import('../store/drive-data')>()),
  sendDriveOps,
}))

import { clearPendingTagUid, pendingPropagationRecords } from './useUploadHistory'

// The transfer tracker clears a finished upload's marker outside React — the app's copy must hear it too.

beforeEach(() => {
  localStorage.clear()
  sendDriveOps.mockClear()
})

it('clearing a finished upload’s marker changes the local copy and sends the same change to the app', () => {
  localStorage.setItem(
    'swarm-drive',
    JSON.stringify([
      { id: 'r1', name: 'a', driveId: 'b', hash: 'h', pendingTagUid: 7 },
      { id: 'r2', name: 'b', driveId: 'b', hash: 'h2', pendingTagUid: 8 },
    ]),
  )
  clearPendingTagUid(7)
  expect(pendingPropagationRecords().map(p => p.tagUid)).toEqual([8])
  expect(sendDriveOps).toHaveBeenCalledWith([
    { kind: 'record', op: 'patch', id: 'r1', changes: { pendingTagUid: null } },
  ])
})
