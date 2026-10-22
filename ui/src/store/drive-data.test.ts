// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({
  getDriveData: vi.fn(),
  changeDriveData: vi.fn(),
  importDriveData: vi.fn(),
}))

vi.mock('../api/server', () => ({ serverApi: api }))

import {
  type DriveStore,
  missingFromApp,
  refreshDriveData,
  resetDriveDataForTests,
  sendDriveOps,
  sharedKey,
  toPatch,
  useDriveDataStore,
} from './drive-data'

// Drive data in the app; localStorage is this browser's synchronous copy.

function store(partial: Partial<DriveStore> = {}): DriveStore {
  return {
    version: 1,
    rev: 1,
    records: [],
    folders: [],
    metadata: {},
    shared: [],
    deleted: { records: {}, folders: {}, shared: {} },
    ...partial,
  }
}

const local = (key: string) => JSON.parse(localStorage.getItem(key) ?? 'null')
const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise(r => setTimeout(r, 0))
}

beforeEach(() => {
  localStorage.clear()
  vi.clearAllMocks()
  resetDriveDataForTests()
})

describe('missingFromApp', () => {
  it('sends only what the app lacks and never what it deleted', () => {
    localStorage.setItem('swarm-drive', JSON.stringify([{ id: 'r1' }, { id: 'r2' }, { id: 'gone' }]))
    localStorage.setItem('nook-folders', JSON.stringify([{ id: 'f1' }]))
    localStorage.setItem(
      'nook-shared-drives',
      JSON.stringify([
        { id: 'local-id', feedTopic: 'AA', feedOwner: '0xbb' },
        { id: 'new', feedTopic: 'cc', feedOwner: 'dd' },
      ]),
    )
    localStorage.setItem(
      'nook-drive-metadata',
      JSON.stringify({ b1: { encrypted: true }, b2: { encrypted: true, lastWrapperRef: 'w' } }),
    )
    const app = store({
      records: [{ id: 'r1' }],
      folders: [{ id: 'f1' }],
      shared: [{ id: 'app-id', feedTopic: 'aa', feedOwner: 'BB' }],
      metadata: { b1: { encrypted: true }, b2: { encrypted: true } },
      deleted: { records: { gone: 1 }, folders: {}, shared: {} },
    })

    expect(missingFromApp(app)).toEqual({
      records: [{ id: 'r2' }],
      folders: [],
      shared: [{ id: 'new', feedTopic: 'cc', feedOwner: 'dd' }],
      metadata: { b2: { encrypted: true, lastWrapperRef: 'w' } },
    })
  })

  it('no endless re-import of ACT state the app already keeps differently', () => {
    localStorage.setItem(
      'nook-drive-metadata',
      JSON.stringify({ b1: { encrypted: true, actHistoryRef: 'old', granteeRef: 'g' } }),
    )
    expect(missingFromApp(store({ metadata: { b1: { encrypted: true, actHistoryRef: 'new' } } }))).toBeNull()
  })

  it('an empty browser (private window) has nothing to send', () => {
    expect(missingFromApp(store({ records: [{ id: 'r1' }] }))).toBeNull()
  })
})

describe('refreshDriveData', () => {
  it('imports what only this browser has, then the app’s data replaces the local copy', async () => {
    localStorage.setItem('swarm-drive', JSON.stringify([{ id: 'mine' }]))
    api.getDriveData.mockResolvedValue(store({ records: [{ id: 'theirs' }] }))
    api.importDriveData.mockResolvedValue(store({ rev: 2, records: [{ id: 'theirs' }, { id: 'mine' }] }))
    const heard = vi.fn()

    window.addEventListener('nook:records-changed', heard)
    await refreshDriveData()
    expect(api.importDriveData).toHaveBeenCalledWith(expect.objectContaining({ records: [{ id: 'mine' }] }))
    expect(local('swarm-drive')).toEqual([{ id: 'theirs' }, { id: 'mine' }])
    expect(local('nook-shared-drives')).toEqual([])
    expect(useDriveDataStore.getState().status).toBe('ready')
    expect(heard).toHaveBeenCalled()
    window.removeEventListener('nook:records-changed', heard)
  })

  it('app unreachable on first load → offline, and the local copy is left alone', async () => {
    localStorage.setItem('swarm-drive', JSON.stringify([{ id: 'mine' }]))
    api.getDriveData.mockRejectedValue(new Error('down'))
    await refreshDriveData()
    expect(useDriveDataStore.getState().status).toBe('offline')
    expect(local('swarm-drive')).toEqual([{ id: 'mine' }])
  })

  it('an unchanged part is not rewritten (no needless storage events for other tabs)', async () => {
    localStorage.setItem('swarm-drive', JSON.stringify([{ id: 'r1' }]))
    localStorage.setItem('nook-folders', '[]')
    localStorage.setItem('nook-drive-metadata', '{}')
    localStorage.setItem('nook-shared-drives', '[]')
    api.getDriveData.mockResolvedValue(store({ records: [{ id: 'r1' }] }))
    const heard = vi.fn()

    window.addEventListener('nook:records-changed', heard)
    await refreshDriveData()
    expect(heard).not.toHaveBeenCalled()
    window.removeEventListener('nook:records-changed', heard)
  })
})

describe('sendDriveOps', () => {
  /** A browser that already offered its data to the app (the normal state after the first load). */
  async function loaded() {
    api.getDriveData.mockResolvedValueOnce(store())
    await refreshDriveData()
  }

  it('sends in order and applies the app’s answer once nothing else is on its way', async () => {
    await loaded()
    api.changeDriveData
      .mockResolvedValueOnce(store({ rev: 2, records: [{ id: 'a' }] }))
      .mockResolvedValueOnce(store({ rev: 3, records: [{ id: 'b' }, { id: 'a' }] }))
    sendDriveOps([{ kind: 'record', op: 'put', value: { id: 'a' } }])
    sendDriveOps([{ kind: 'record', op: 'put', value: { id: 'b' } }])
    await flush()
    expect(api.changeDriveData.mock.calls.map(c => c[0][0].value.id)).toEqual(['a', 'b'])
    expect(local('swarm-drive')).toEqual([{ id: 'b' }, { id: 'a' }])
    expect(localStorage.getItem('nook-drive-ops-pending')).toBeNull()
  })

  it('an answer before the first import never erases data only this browser has', async () => {
    // e.g. a change kept from before a downgrade, sent on the first load after re-upgrading
    localStorage.setItem('swarm-drive', JSON.stringify([{ id: 'from-0.7.2' }]))
    api.changeDriveData.mockResolvedValueOnce(store({ rev: 4 }))
    sendDriveOps([{ kind: 'record', op: 'patch', id: 'x', changes: { name: 'y' } }])
    await flush()
    expect(local('swarm-drive')).toEqual([{ id: 'from-0.7.2' }])
    api.getDriveData.mockResolvedValueOnce(store({ rev: 4 }))
    api.importDriveData.mockResolvedValueOnce(store({ rev: 5, records: [{ id: 'from-0.7.2' }] }))
    await refreshDriveData()
    expect(api.importDriveData).toHaveBeenCalledWith(expect.objectContaining({ records: [{ id: 'from-0.7.2' }] }))
    expect(local('swarm-drive')).toEqual([{ id: 'from-0.7.2' }])
  })

  it('kept while the app is unreachable, sent with the next refresh', async () => {
    api.changeDriveData.mockRejectedValueOnce(new Error('down'))
    sendDriveOps([{ kind: 'record', op: 'delete', id: 'x' }])
    await flush()
    expect(local('nook-drive-ops-pending')).toEqual([
      { id: expect.any(String), ops: [{ kind: 'record', op: 'delete', id: 'x' }] },
    ])
    api.changeDriveData.mockResolvedValueOnce(store({ rev: 5 }))
    api.getDriveData.mockResolvedValue(store({ rev: 5 }))
    await refreshDriveData()
    expect(api.changeDriveData).toHaveBeenCalledTimes(2)
    expect(localStorage.getItem('nook-drive-ops-pending')).toBeNull()
  })

  it('a batch the app refuses is dropped instead of blocking the rest', async () => {
    await loaded()
    api.changeDriveData
      .mockRejectedValueOnce(new Error('Invalid ops'))
      .mockResolvedValueOnce(store({ records: [{ id: 'ok' }] }))
    sendDriveOps([{ kind: 'record', op: 'put', value: { id: '' } }])
    sendDriveOps([{ kind: 'record', op: 'put', value: { id: 'ok' } }])
    await flush()
    expect(local('swarm-drive')).toEqual([{ id: 'ok' }])
  })

  it('a sent batch is removed by id, so a batch another tab added meanwhile stays', async () => {
    await loaded()
    let release: (s: DriveStore) => void = () => undefined

    api.changeDriveData.mockImplementationOnce(async () => new Promise<DriveStore>(r => (release = r)))
    sendDriveOps([{ kind: 'record', op: 'put', value: { id: 'a' } }])
    await flush()
    // Another tab sharing the queue sent the first batch too and removed it, then queued its own.
    const other = { id: 'other-tab', ops: [{ kind: 'record', op: 'put', value: { id: 'b' } }] }

    localStorage.setItem('nook-drive-ops-pending', JSON.stringify([other]))
    api.changeDriveData.mockResolvedValueOnce(store({ records: [{ id: 'b' }, { id: 'a' }] }))
    release(store({ records: [{ id: 'a' }] }))
    await flush()
    expect(api.changeDriveData.mock.calls.map(c => c[0][0].value.id)).toEqual(['a', 'b'])
    expect(localStorage.getItem('nook-drive-ops-pending')).toBeNull()
  })
})

describe('helpers', () => {
  it('toPatch turns undefined into null (= remove the field)', () => {
    expect(toPatch({ folderId: undefined, name: 'x' })).toEqual({ folderId: null, name: 'x' })
  })

  it('sharedKey ignores case and 0x; no feed → the id', () => {
    expect(sharedKey({ id: '1', feedTopic: '0xAA', feedOwner: 'BB' })).toBe(
      sharedKey({ id: '2', feedTopic: 'aa', feedOwner: '0xbb' }),
    )
    expect(sharedKey({ id: '7' })).toBe('id:7')
  })
})
