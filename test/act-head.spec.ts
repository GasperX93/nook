jest.mock('env-paths', () =>
  jest.fn().mockImplementation(() => ({
    data: 'test/data/act-head-spec',
    config: 'test/data/act-head-spec',
    cache: 'test/data/act-head-spec',
    log: 'test/data/act-head-spec',
    temp: 'test/data/act-head-spec',
  })),
)

import { mkdirSync, rmSync } from 'fs'

import {
  changeAccess,
  driveHead,
  grantAccess,
  resetActHeadState,
  uploadActMetadata,
  type ActBee,
} from '../src/act-head'
import { changeDriveData, getActState, importDriveData, resetDriveDataCache, setActState } from '../src/drive-data'

// The app keeps each encrypted drive's ACT head and is the only one that moves it.

const DIR = 'test/data/act-head-spec'
const B = 'batch1'

/** A fake Bee: every grantee change makes a new history h1, h2, …; uploads return the history they got. */
function fakeBee() {
  let n = 0
  const calls: string[] = []
  const bee: ActBee = {
    async createGrantees(_stamp, grantees, historyRef) {
      calls.push(`create ${grantees.join(',')} on ${historyRef ?? '-'}`)
      await new Promise(r => setTimeout(r, 20))
      n++

      return { ref: `g${n}`, historyRef: `h${n}` }
    },
    async patchGrantees(_stamp, granteeRef, historyRef, add, revoke) {
      calls.push(`patch ${granteeRef} on ${historyRef} +${(add ?? []).join(',')} -${(revoke ?? []).join(',')}`)
      await new Promise(r => setTimeout(r, 20))
      n++

      return { ref: `g${n}`, historyRef: `h${n}` }
    },
    async uploadActBytes(_stamp, data, historyRef) {
      calls.push(`upload ${data.toString()} on ${historyRef ?? '-'}`)
      await new Promise(r => setTimeout(r, 20))

      if (historyRef) return { reference: 'ref', historyRef }
      n++

      return { reference: 'ref', historyRef: `h${n}` }
    },
  }

  return { bee, calls, at: [] as number[] }
}

beforeEach(() => {
  rmSync(DIR, { recursive: true, force: true })
  mkdirSync(DIR, { recursive: true })
  resetDriveDataCache()
  resetActHeadState()
})
afterAll(() => rmSync(DIR, { recursive: true, force: true }))

test('two first uploads at once get one history, created once', async () => {
  const { bee, calls } = fakeBee()
  const [a, b] = await Promise.all([driveHead(bee, B), driveHead(bee, B)])

  expect(a).toBe('h1')
  expect(b).toBe('h1')
  expect(calls).toEqual(['upload nook on -'])
  expect(getActState(B)?.actHistoryRef).toBe('h1')
})

test('a drive the app has no head for yet uses the browser’s, without adopting it', async () => {
  const { bee, calls } = fakeBee()

  expect(await driveHead(bee, B, 'old')).toBe('old')
  expect(calls).toEqual([])
  expect(getActState(B)).toBeUndefined()
})

test('grants build on the stored head and list; the browser’s stale head is ignored', async () => {
  const { bee, calls } = fakeBee()

  await driveHead(bee, B)
  await grantAccess(bee, B, ['ana'], { historyRef: 'stale' })
  await grantAccess(bee, B, ['luka'], { historyRef: 'stale', granteeRef: 'stale-list' })
  expect(calls.slice(1)).toEqual(['create ana on h1', 'patch g2 on h2 +luka -'])
  expect(getActState(B)).toMatchObject({
    actHistoryRef: 'h3',
    granteeRef: 'g3',
    headsSinceRotation: ['h1', 'h2', 'h3'],
  })
})

test('two grants at once run one after the other, at least 1.1 s apart, and neither is lost', async () => {
  const { bee, calls } = fakeBee()

  setActState(B, { actHistoryRef: 'h0', granteeRef: 'g0' })
  const started = Date.now()

  await Promise.all([grantAccess(bee, B, ['ana'], {}), grantAccess(bee, B, ['luka'], {})])
  expect(Date.now() - started).toBeGreaterThanOrEqual(1100)
  expect(calls).toEqual(['patch g0 on h0 +ana -', 'patch g1 on h1 +luka -'])
  expect(getActState(B)?.actHistoryRef).toBe('h2')
})

test('the shared file list waits for a grant in progress and uses its new head', async () => {
  const { bee, calls } = fakeBee()

  setActState(B, { actHistoryRef: 'h0', granteeRef: 'g0' })
  await Promise.all([grantAccess(bee, B, ['ana'], {}), uploadActMetadata(bee, B, Buffer.from('{"files":[]}'), 'h0')])
  expect(calls).toEqual(['patch g0 on h0 +ana -', 'upload {"files":[]} on h1'])
})

test('a revoke rotates the key: keyRotated, heads start again, the old ones are retired', async () => {
  const { bee } = fakeBee()

  setActState(B, { actHistoryRef: 'h0', granteeRef: 'g0', headsSinceRotation: ['hA', 'h0'] })
  await changeAccess(bee, B, { revoke: ['ana'] }, { historyRef: 'h0', granteeRef: 'g0' })
  expect(getActState(B)).toMatchObject({
    actHistoryRef: 'h1',
    granteeRef: 'g1',
    keyRotated: true,
    headsSinceRotation: ['h1'],
    retiredHeads: ['hA', 'h0'],
  })
})

test('an upload under a retired head that finishes after the revoke flags the drive for re-publish', async () => {
  const { bee } = fakeBee()

  setActState(B, { actHistoryRef: 'h0', granteeRef: 'g0' })
  await changeAccess(bee, B, { revoke: ['ana'] }, {})
  changeDriveData([{ kind: 'metadata', op: 'patch', batch: B, changes: { keyRotated: false } }])
  changeDriveData([
    { kind: 'record', op: 'put', value: { id: 'r1', driveId: B, isEncrypted: true, actHistoryRef: 'h0' } },
  ])
  expect(getActState(B)?.keyRotated).toBe(true)
})

test('browsers can’t move the head, overwrite the list, or set keyRotated — only clear it', () => {
  setActState(B, { actHistoryRef: 'h5', granteeRef: 'g5', keyRotated: true })
  // What an upload finishing after a grant used to write back (the old head).
  changeDriveData([
    { kind: 'metadata', op: 'patch', batch: B, changes: { actHistoryRef: 'h1', granteeRef: 'g1', granteeCount: 3 } },
  ])
  expect(getActState(B)).toMatchObject({ actHistoryRef: 'h5', granteeRef: 'g5', granteeCount: 3 })
  changeDriveData([{ kind: 'metadata', op: 'patch', batch: B, changes: { keyRotated: false } }])
  expect(getActState(B)?.keyRotated).toBe(false)
  changeDriveData([{ kind: 'metadata', op: 'patch', batch: B, changes: { keyRotated: true } }])
  expect(getActState(B)?.keyRotated).toBe(false)
  changeDriveData([{ kind: 'metadata', op: 'delete', batch: B }])
  expect(getActState(B)?.actHistoryRef).toBe('h5')
})

test('a drive the app has no ACT state for still takes the browser’s values (import / first grant)', async () => {
  importDriveData({ metadata: { [B]: { encrypted: true, actHistoryRef: 'hx', granteeRef: 'gx' } } })
  const { bee, calls } = fakeBee()

  await grantAccess(bee, B, ['ana'], {})
  expect(calls).toEqual(['patch gx on hx +ana -'])
})

test('a failed Bee call leaves the stored head alone and doesn’t block the next change', async () => {
  const { bee } = fakeBee()

  setActState(B, { actHistoryRef: 'h0', granteeRef: 'g0' })
  const failing: ActBee = { ...bee, patchGrantees: async () => Promise.reject(new Error('Bee down')) }

  await expect(grantAccess(failing, B, ['ana'], {})).rejects.toThrow('Bee down')
  expect(getActState(B)?.actHistoryRef).toBe('h0')
  await grantAccess(bee, B, ['ana'], {})
  expect(getActState(B)?.actHistoryRef).toBe('h1')
})
