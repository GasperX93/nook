jest.mock('env-paths', () =>
  jest.fn().mockImplementation(() => ({
    data: 'test/data/drive-data-spec',
    config: 'test/data/drive-data-spec',
    cache: 'test/data/drive-data-spec',
    log: 'test/data/drive-data-spec',
    temp: 'test/data/drive-data-spec',
  })),
)

import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'fs'

import {
  applyOps,
  changeDriveData,
  emptyStore,
  importDriveData,
  importLocal,
  loadDriveStore,
  parseOps,
  resetDriveDataCache,
  sharedKey,
  type DriveStore,
} from '../src/drive-data'

// Classic drive data in the app: one store every browser reads and changes.

const DIR = 'test/data/drive-data-spec'

const rec = (id: string, extra: Record<string, unknown> = {}) => ({ id, name: `${id}.txt`, driveId: 'b1', ...extra })
const shared = (id: string, topic = 'aa', owner = '0xBB') => ({
  id,
  name: 'Photos',
  feedTopic: topic,
  feedOwner: owner,
})

function fresh(): DriveStore {
  return emptyStore()
}

beforeEach(() => {
  rmSync(DIR, { recursive: true, force: true })
  mkdirSync(DIR, { recursive: true })
  resetDriveDataCache()
})
afterAll(() => rmSync(DIR, { recursive: true, force: true }))

describe('parseOps', () => {
  test('accepts every op shape', () => {
    expect(
      parseOps([
        { kind: 'record', op: 'put', value: rec('r1') },
        { kind: 'record', op: 'patch', id: 'r1', changes: { name: 'x' } },
        { kind: 'folder', op: 'delete', id: 'f1' },
        { kind: 'metadata', op: 'patch', batch: 'b1', changes: { encrypted: true } },
        { kind: 'metadata', op: 'delete', batch: 'b1' },
      ]),
    ).toHaveLength(5)
  })

  test('one malformed op refuses the whole request', () => {
    expect(
      parseOps([
        { kind: 'record', op: 'put', value: rec('r1') },
        { kind: 'record', op: 'put', value: {} },
      ]),
    ).toBeNull()
    expect(parseOps([{ kind: 'nope', op: 'put', value: rec('r1') }])).toBeNull()
    expect(parseOps([{ kind: 'metadata', op: 'patch', batch: 'b1', changes: [] }])).toBeNull()
    expect(parseOps([{ kind: 'record', op: 'patch', id: '', changes: {} }])).toBeNull()
    expect(parseOps([])).toBeNull()
    expect(parseOps('ops')).toBeNull()
  })
})

describe('applyOps', () => {
  test('put adds new records on top, replaces an existing one, and bumps rev', () => {
    const s = fresh()

    applyOps(s, [{ kind: 'record', op: 'put', value: rec('r1') }])
    applyOps(s, [{ kind: 'record', op: 'put', value: rec('r2') }])
    applyOps(s, [{ kind: 'record', op: 'put', value: rec('r1', { name: 'renamed' }) }])
    expect(s.records.map(r => r.id)).toEqual(['r2', 'r1'])
    expect(s.records[1].name).toBe('renamed')
    expect(s.rev).toBe(3)
  })

  test('patch merges, null removes a field, the id never changes, a missing item is a no-op', () => {
    const s = fresh()

    applyOps(s, [{ kind: 'record', op: 'put', value: rec('r1', { pendingTagUid: 7, folderId: 'f1' }) }])
    applyOps(s, [
      { kind: 'record', op: 'patch', id: 'r1', changes: { pendingTagUid: null, id: 'zzz', ensDomain: 'a.eth' } },
    ])
    expect(s.records[0]).toEqual(rec('r1', { folderId: 'f1', ensDomain: 'a.eth' }))
    expect(applyOps(s, [{ kind: 'record', op: 'patch', id: 'gone', changes: { name: 'x' } }])).toBe(false)
  })

  test('a deleted record leaves a tombstone and a late put cannot bring it back', () => {
    const s = fresh()

    applyOps(s, [{ kind: 'record', op: 'put', value: rec('r1') }])
    applyOps(s, [{ kind: 'record', op: 'delete', id: 'r1' }], 1000)
    expect(s.records).toEqual([])
    expect(s.deleted.records).toEqual({ r1: 1000 })
    expect(applyOps(s, [{ kind: 'record', op: 'put', value: rec('r1') }])).toBe(false)
    expect(s.records).toEqual([])
  })

  test('deleting a folder removes the folders below it and moves their files to the top level', () => {
    const s = fresh()

    applyOps(s, [
      { kind: 'folder', op: 'put', value: { id: 'f1', name: 'a', driveId: 'b1' } },
      { kind: 'folder', op: 'put', value: { id: 'f2', name: 'b', driveId: 'b1', parentFolderId: 'f1' } },
      { kind: 'folder', op: 'put', value: { id: 'f3', name: 'c', driveId: 'b1', parentFolderId: 'f2' } },
      { kind: 'folder', op: 'put', value: { id: 'other', name: 'd', driveId: 'b1' } },
      { kind: 'record', op: 'put', value: rec('r1', { folderId: 'f3' }) },
      { kind: 'record', op: 'put', value: rec('r2', { folderId: 'other' }) },
    ])
    applyOps(s, [{ kind: 'folder', op: 'delete', id: 'f1' }], 5)
    expect(s.folders.map(f => f.id)).toEqual(['other'])
    expect(s.deleted.folders).toEqual({ f1: 5, f2: 5, f3: 5 })
    expect(s.records.find(r => r.id === 'r1')).not.toHaveProperty('folderId')
    expect(s.records.find(r => r.id === 'r2')?.folderId).toBe('other')
  })

  test('a shared drive is the same drive per feed: re-adding updates it and keeps id + addedAt', () => {
    const s = fresh()

    applyOps(s, [{ kind: 'shared', op: 'put', value: { ...shared('s1'), addedAt: 1 } }])
    applyOps(s, [{ kind: 'shared', op: 'put', value: { ...shared('s2', 'AA', 'bb'), name: 'New name', addedAt: 2 } }])
    expect(s.shared).toEqual([{ ...shared('s1'), name: 'New name', feedTopic: 'AA', feedOwner: 'bb', addedAt: 1 }])
  })

  test('removing a shared drive tombstones its feed; adding it again is the user’s choice and clears that', () => {
    const s = fresh()

    applyOps(s, [{ kind: 'shared', op: 'put', value: shared('s1') }])
    applyOps(s, [{ kind: 'shared', op: 'delete', id: 's1' }], 9)
    expect(s.deleted.shared).toEqual({ [sharedKey(shared('s1'))]: 9 })
    applyOps(s, [{ kind: 'shared', op: 'put', value: shared('s3') }])
    expect(s.shared.map(d => d.id)).toEqual(['s3'])
    expect(s.deleted.shared).toEqual({})
  })

  test('metadata patch starts from {encrypted:false}, merges, and null removes', () => {
    const s = fresh()

    applyOps(s, [{ kind: 'metadata', op: 'patch', batch: 'b1', changes: { lastWrapperRef: 'w1' } }])
    expect(s.metadata.b1).toEqual({ encrypted: false, lastWrapperRef: 'w1' })
    applyOps(s, [{ kind: 'metadata', op: 'patch', batch: 'b1', changes: { encrypted: true, lastWrapperRef: null } }])
    expect(s.metadata.b1).toEqual({ encrypted: true })
    applyOps(s, [{ kind: 'metadata', op: 'delete', batch: 'b1' }])
    expect(s.metadata).toEqual({})
  })
})

describe('importLocal', () => {
  test('adds what the app lacks, never overwrites, skips tombstones, and repeating it changes nothing', () => {
    const s = fresh()

    applyOps(s, [{ kind: 'record', op: 'put', value: rec('r1', { name: 'server' }) }])
    applyOps(s, [
      { kind: 'record', op: 'put', value: rec('gone') },
      { kind: 'record', op: 'delete', id: 'gone' },
    ])
    const data = {
      records: [rec('r1', { name: 'browser' }), rec('r2'), rec('gone'), { no: 'id' }],
      folders: [{ id: 'f1', name: 'a', driveId: 'b1' }],
      shared: [shared('s1')],
    }

    expect(importLocal(s, data)).toBe(true)
    expect(s.records.map(r => [r.id, r.name])).toEqual([
      ['r1', 'server'],
      ['r2', 'r2.txt'],
    ])
    expect(s.folders).toHaveLength(1)
    expect(s.shared).toHaveLength(1)
    const rev = s.rev

    expect(importLocal(s, data)).toBe(false)
    expect(s.rev).toBe(rev)
  })

  test('a shared drive from another browser (other id, same feed) is not added twice, nor a removed one', () => {
    const s = fresh()

    applyOps(s, [{ kind: 'shared', op: 'put', value: shared('s1') }])
    applyOps(s, [
      { kind: 'shared', op: 'put', value: shared('x1', 'cc', '0xdd') },
      { kind: 'shared', op: 'delete', id: 'x1' },
    ])
    importLocal(s, { shared: [shared('other-id', '0xAA', 'bb'), shared('x2', 'cc', 'dd')] })
    expect(s.shared.map(d => d.id)).toEqual(['s1'])
  })

  test('metadata: whole entry when absent; the ACT pair only as a unit; other missing fields filled in', () => {
    const s = fresh()

    applyOps(s, [{ kind: 'metadata', op: 'patch', batch: 'b1', changes: { encrypted: true } }])
    importLocal(s, {
      metadata: {
        b1: { encrypted: true, actHistoryRef: 'h1', granteeRef: 'g1', granteeCount: 2, lastWrapperRef: 'w1' },
        b2: { encrypted: false },
      },
    })
    expect(s.metadata.b1).toEqual({
      encrypted: true,
      actHistoryRef: 'h1',
      granteeRef: 'g1',
      granteeCount: 2,
      lastWrapperRef: 'w1',
    })
    expect(s.metadata.b2).toEqual({ encrypted: false })
  })

  test('two browsers with different ACT histories: the first stays and the drive is marked', () => {
    const s = fresh()

    importLocal(s, { metadata: { b1: { encrypted: true, actHistoryRef: 'h1', granteeRef: 'g1' } } })
    importLocal(s, { metadata: { b1: { encrypted: true, actHistoryRef: 'h2', granteeRef: 'g2', keyRotated: true } } })
    expect(s.metadata.b1).toEqual({
      encrypted: true,
      actHistoryRef: 'h1',
      granteeRef: 'g1',
      headConflict: true,
      keyRotated: true,
    })
  })
  test('a malformed import adds nothing and does not throw', () => {
    const s = fresh()

    expect(importLocal(s, { records: 'abc', folders: { id: 'x' }, shared: 5, metadata: [] } as never)).toBe(false)
    expect(s).toEqual(emptyStore())
  })
})

describe('the file', () => {
  test('changes are saved and read back after a restart', () => {
    changeDriveData([{ kind: 'record', op: 'put', value: rec('r1') }])
    importDriveData({ records: [rec('r2')] })
    resetDriveDataCache()
    expect(loadDriveStore().records.map(r => r.id)).toEqual(['r1', 'r2'])
    expect(loadDriveStore().rev).toBe(2)
  })

  test('nothing changed → nothing written', () => {
    changeDriveData([{ kind: 'record', op: 'patch', id: 'none', changes: {} }])
    expect(existsSync(`${DIR}/drives.json`)).toBe(false)
  })

  test('a damaged file falls back to the previous copy and is kept aside', () => {
    changeDriveData([{ kind: 'record', op: 'put', value: rec('r1') }])
    changeDriveData([{ kind: 'record', op: 'put', value: rec('r2') }])
    writeFileSync(`${DIR}/drives.json`, '{"version":1,"records":[')
    resetDriveDataCache()
    expect(loadDriveStore().records.map(r => r.id)).toEqual(['r1'])
    expect(readdirSync(DIR).some(f => f.startsWith('drives.json.damaged-'))).toBe(true)
  })

  test('damaged with no previous copy → starts empty, damaged file kept', () => {
    writeFileSync(`${DIR}/drives.json`, 'not json')
    expect(loadDriveStore()).toEqual(emptyStore())
    expect(readdirSync(DIR).some(f => f.startsWith('drives.json.damaged-'))).toBe(true)
  })

  test('a failed change leaves the saved copy as it was', () => {
    changeDriveData([{ kind: 'record', op: 'put', value: rec('r1') }])
    const before = JSON.stringify(loadDriveStore())

    changeDriveData([{ kind: 'record', op: 'delete', id: 'nope' }])
    expect(JSON.stringify(loadDriveStore())).toBe(before)
  })
})
