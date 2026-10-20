jest.mock('../src/config', () => ({
  ...jest.requireActual('../src/config'),
  readConfigYaml: () => ({ password: 'pw' }),
}))
jest.mock('../src/foreign-bee', () => ({ isOwnBee: jest.fn(async () => true) }))

import { type BeeFetch, resetDepthSaveForTests, runDepthSave } from '../src/depth-save'
import { isOwnBee } from '../src/foreign-bee'

// A size change lives only in Bee's memory until the drive is saved; Nook
// re-saves the name when Bee shows a bigger size, and nothing else.

const A = 'a'.repeat(64)
const B = 'b'.repeat(64)

function makeBee(stamps: { batchID: string; depth: number; label?: string }[], patchStatus = 200) {
  const patches: { id: string; label: string }[] = []
  const fetch: BeeFetch = async (path, init) => {
    if (path === '/stamps') return new Response(JSON.stringify({ stamps }), { status: 200 })

    if (init?.method === 'PATCH') {
      patches.push({ id: path.split('/')[2], label: JSON.parse(String(init.body)).label })

      return new Response(null, { status: patchStatus })
    }

    return new Response(null, { status: 404 })
  }

  return { fetch, patches, stamps }
}

beforeEach(() => {
  resetDepthSaveForTests()
  ;(isOwnBee as jest.Mock).mockResolvedValue(true)
})

test('first sighting saves nothing (it is what Bee loaded from disk)', async () => {
  const bee = makeBee([{ batchID: A, depth: 19, label: 'photos' }])

  expect(await runDepthSave(bee.fetch)).toEqual([])
  expect(bee.patches).toEqual([])
})

test('a bigger size is saved once, with the drive’s own name', async () => {
  const bee = makeBee([
    { batchID: A, depth: 19, label: 'photos' },
    { batchID: B, depth: 21, label: 'site' },
  ])

  await runDepthSave(bee.fetch)
  bee.stamps[0].depth = 20
  expect(await runDepthSave(bee.fetch)).toEqual([A])
  expect(bee.patches).toEqual([{ id: A, label: 'photos' }])
  await runDepthSave(bee.fetch)
  expect(bee.patches).toHaveLength(1)
})

test('a smaller size (Bee restarted) is remembered, not saved', async () => {
  const bee = makeBee([{ batchID: A, depth: 20, label: 'photos' }])

  await runDepthSave(bee.fetch)
  bee.stamps[0].depth = 19
  await runDepthSave(bee.fetch)
  expect(bee.patches).toEqual([])
  // …and a later real size change from there is saved.
  bee.stamps[0].depth = 20
  expect(await runDepthSave(bee.fetch)).toEqual([A])
})

test('a failed save is tried again on the next pass', async () => {
  const bee = makeBee([{ batchID: A, depth: 19, label: 'photos' }], 500)

  await runDepthSave(bee.fetch)
  bee.stamps[0].depth = 20
  expect(await runDepthSave(bee.fetch)).toEqual([])
  expect(await runDepthSave(bee.fetch)).toEqual([])
  expect(bee.patches).toHaveLength(2)
})

test('an unnamed drive is skipped (Bee refuses an empty name)', async () => {
  const bee = makeBee([{ batchID: A, depth: 19, label: '' }])

  await runDepthSave(bee.fetch)
  bee.stamps[0].depth = 20
  expect(await runDepthSave(bee.fetch)).toEqual([])
  expect(bee.patches).toEqual([])
})

test('never touches a node that is not Nook’s own', async () => {
  const bee = makeBee([{ batchID: A, depth: 19, label: 'photos' }])

  await runDepthSave(bee.fetch)
  ;(isOwnBee as jest.Mock).mockResolvedValue(false)
  bee.stamps[0].depth = 20
  expect(await runDepthSave(bee.fetch)).toEqual([])
  expect(bee.patches).toEqual([])
})
