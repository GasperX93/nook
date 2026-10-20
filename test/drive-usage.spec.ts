jest.mock('../src/config', () => ({
  ...jest.requireActual('../src/config'),
  readConfigYaml: () => ({ password: 'pw' }),
}))

import { type BeeFetch, getDriveUsage, resetDriveUsageForTests } from '../src/drive-usage'

// Used space = every bucket's count added up (4 KB a chunk), not the fullest
// bucket times the size.

const A = 'a'.repeat(64)
const B = 'b'.repeat(64)

function makeBee(stamps: { batchID: string; depth: number; usable: boolean }[], counts: Record<string, number[]>) {
  const calls: string[] = []
  const fetch: BeeFetch = async path => {
    calls.push(path)

    if (path === '/stamps') return new Response(JSON.stringify({ stamps }), { status: 200 })
    const id = path.split('/')[2]

    if (counts[id]) {
      return new Response(JSON.stringify({ buckets: counts[id].map(collisions => ({ collisions })) }), { status: 200 })
    }

    return new Response(null, { status: 404 })
  }

  return { fetch, calls, stamps }
}

beforeEach(() => resetDriveUsageForTests())

test('adds up every bucket', async () => {
  const bee = makeBee([{ batchID: A, depth: 21, usable: true }], { [A]: [7, 0, 2, 1] })

  expect(await getDriveUsage(bee.fetch)).toEqual({ [A]: 10 * 4096 })
})

test('skips drives that are not usable or that Bee cannot list', async () => {
  const bee = makeBee(
    [
      { batchID: A, depth: 21, usable: false },
      { batchID: B, depth: 21, usable: true },
    ],
    {},
  )

  expect(await getDriveUsage(bee.fetch)).toEqual({})
})

test('cached for two minutes, read again after a size change', async () => {
  const bee = makeBee([{ batchID: A, depth: 19, usable: true }], { [A]: [1] })

  await getDriveUsage(bee.fetch, 0)
  await getDriveUsage(bee.fetch, 60_000)
  expect(bee.calls.filter(c => c.includes('/buckets'))).toHaveLength(1)
  bee.stamps[0].depth = 20
  await getDriveUsage(bee.fetch, 61_000)
  expect(bee.calls.filter(c => c.includes('/buckets'))).toHaveLength(2)
  await getDriveUsage(bee.fetch, 61_000 + 2 * 60_000)
  expect(bee.calls.filter(c => c.includes('/buckets'))).toHaveLength(3)
})
