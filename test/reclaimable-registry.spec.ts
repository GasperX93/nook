jest.mock('env-paths', () =>
  jest.fn().mockImplementation(() => ({
    data: 'test/data',
    config: 'test/data',
    cache: 'test/data',
    log: 'test/data',
    temp: 'test/data',
  })),
)

import { existsSync, unlinkSync, writeFileSync } from 'fs'

import {
  MIN_RECLAIMABLE_DEPTH,
  RECLAIMABLE_WRITE_BLOCKED_MESSAGE,
  findBlockedBeeWrite,
  isReclaimableBatch,
  listReclaimableBatches,
  registerReclaimableBatch,
  resetReclaimableRegistryCache,
} from '../src/reclaimable-registry'

const REGISTRY = 'test/data/reclaimable-batches.json'
const BATCH_A = 'a'.repeat(64)
const BATCH_B = 'b'.repeat(64)

function cleanUp() {
  if (existsSync(REGISTRY)) {
    unlinkSync(REGISTRY)
  }
  resetReclaimableRegistryCache()
}

function entry(batchId: string, depth = 20) {
  return { batchId, depth, encrypted: false, createdAt: '2026-07-15T00:00:00.000Z' }
}

describe('reclaimable registry', () => {
  beforeEach(cleanUp)
  afterAll(cleanUp)

  test('empty when no registry file exists', () => {
    expect(listReclaimableBatches()).toEqual([])
    expect(isReclaimableBatch(BATCH_A)).toBe(false)
  })

  test('register and look up a batch', () => {
    registerReclaimableBatch(entry(BATCH_A))
    expect(isReclaimableBatch(BATCH_A)).toBe(true)
    expect(isReclaimableBatch(BATCH_B)).toBe(false)
    expect(listReclaimableBatches()).toHaveLength(1)
  })

  test('registry persists across cache resets (fresh process)', () => {
    registerReclaimableBatch(entry(BATCH_A))
    resetReclaimableRegistryCache()
    expect(isReclaimableBatch(BATCH_A)).toBe(true)
  })

  test('lookup is case-insensitive, storage is normalized lowercase', () => {
    registerReclaimableBatch(entry(BATCH_A.toUpperCase()))
    expect(isReclaimableBatch(BATCH_A)).toBe(true)
    expect(isReclaimableBatch(BATCH_A.toUpperCase())).toBe(true)
    expect(listReclaimableBatches()[0].batchId).toBe(BATCH_A)
  })

  test('re-registering the same batch does not duplicate it', () => {
    registerReclaimableBatch(entry(BATCH_A))
    registerReclaimableBatch({ ...entry(BATCH_A), label: 'renamed' })
    expect(listReclaimableBatches()).toHaveLength(1)
    expect(listReclaimableBatches()[0].label).toBe('renamed')
  })

  test('rejects malformed batch IDs', () => {
    expect(() => registerReclaimableBatch(entry('not-hex'))).toThrow('Invalid batch ID')
    expect(() => registerReclaimableBatch(entry(BATCH_A.slice(0, 63)))).toThrow('Invalid batch ID')
  })

  test('rejects depth below the swarm-fs safety floor', () => {
    // depth < 19 silently corrupts the slot ledger upstream (swarm-fs#1)
    expect(() => registerReclaimableBatch(entry(BATCH_A, MIN_RECLAIMABLE_DEPTH - 1))).toThrow('depth')
    expect(() => registerReclaimableBatch(entry(BATCH_A, 17.5))).toThrow('depth')
    registerReclaimableBatch(entry(BATCH_A, MIN_RECLAIMABLE_DEPTH))
    expect(isReclaimableBatch(BATCH_A)).toBe(true)
  })

  test('corrupt registry file fails open with empty list', () => {
    writeFileSync(REGISTRY, '{ not json')
    expect(listReclaimableBatches()).toEqual([])
    expect(isReclaimableBatch(BATCH_A)).toBe(false)
  })
})

describe('findBlockedBeeWrite (bee-api proxy guard)', () => {
  beforeEach(() => {
    cleanUp()
    registerReclaimableBatch(entry(BATCH_A))
  })
  afterAll(cleanUp)

  test('blocks writes stamping a reclaimable batch', () => {
    for (const method of ['POST', 'PUT', 'PATCH']) {
      expect(findBlockedBeeWrite(method, '/bzz', { 'swarm-postage-batch-id': BATCH_A })).toBe(
        RECLAIMABLE_WRITE_BLOCKED_MESSAGE,
      )
    }
  })

  test('allows writes stamping other batches', () => {
    expect(findBlockedBeeWrite('POST', '/bzz', { 'swarm-postage-batch-id': BATCH_B })).toBeNull()
  })

  test('allows writes with no stamp header (feed/SOC reads, chequebook, etc.)', () => {
    expect(findBlockedBeeWrite('POST', '/chequebook/withdraw', {})).toBeNull()
  })

  test('allows reads of reclaimable content', () => {
    expect(findBlockedBeeWrite('GET', '/bzz/somehash/', {})).toBeNull()
    expect(findBlockedBeeWrite('GET', `/stamps/${BATCH_A}`, {})).toBeNull()
  })

  test('header lookup is case-insensitive on the batch ID', () => {
    expect(findBlockedBeeWrite('POST', '/bytes', { 'swarm-postage-batch-id': BATCH_A.toUpperCase() })).toBe(
      RECLAIMABLE_WRITE_BLOCKED_MESSAGE,
    )
  })

  test('blocks dilute on a reclaimable batch (depth change breaks the ledger)', () => {
    expect(findBlockedBeeWrite('PATCH', `/stamps/dilute/${BATCH_A}/21`, {})).toBe(RECLAIMABLE_WRITE_BLOCKED_MESSAGE)
    expect(findBlockedBeeWrite('PATCH', `/stamps/dilute/${BATCH_B}/21`, {})).toBeNull()
  })

  test('allows top-up on a reclaimable batch (TTL only, slots untouched)', () => {
    expect(findBlockedBeeWrite('PATCH', `/stamps/topup/${BATCH_A}/1000000`, {})).toBeNull()
  })
})
