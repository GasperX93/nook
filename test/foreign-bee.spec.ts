import { checkBeePorts } from '../src/foreign-bee'

jest.mock('../src/logger', () => ({ logger: { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() } }))
jest.mock('../src/path', () => ({ getPath: (p: string) => p }))

const OWN = 'aaaa000000000000000000000000000000000001'
const OTHER = 'bbbb000000000000000000000000000000000002'

/** Probes with scripted answers; sleep is instant. */
function probes(opts: { api: boolean[] | boolean; p2p: boolean[] | boolean; address: (string | null)[] | string | null }) {
  const seq = <T>(v: T[] | T) => {
    const list = Array.isArray(v) ? [...v] : [v]

    return () => (list.length > 1 ? list.shift() : list[0]) as T
  }
  const api = seq(opts.api)
  const p2p = seq(opts.p2p)
  const address = seq(opts.address)

  return {
    portOpen: jest.fn(async (port: number) => (port === 1633 ? api() : p2p())),
    addressOnApiPort: jest.fn(async () => address()),
    ownBeeAddress: jest.fn(() => OWN),
    sleep: jest.fn(async (): Promise<void> => undefined),
  }
}

describe('checkBeePorts (R5-11)', () => {
  it('free when nothing holds 1633 or 1634', async () => {
    expect(await checkBeePorts(probes({ api: false, p2p: false, address: null }))).toEqual({ kind: 'free' })
  })

  it("recognises Nook's own node left over from an earlier session", async () => {
    expect(await checkBeePorts(probes({ api: true, p2p: true, address: OWN }))).toEqual({ kind: 'own' })
  })

  it('flags a different node on the API port at once, with its address', async () => {
    const p = probes({ api: true, p2p: true, address: OTHER })

    expect(await checkBeePorts(p)).toEqual({ kind: 'foreign', port: 1633, address: `0x${OTHER}` })
    expect(p.sleep).not.toHaveBeenCalled()
  })

  it('gives a node that is still starting a few chances to identify itself', async () => {
    // API up but /addresses not answering yet, then it answers as Nook's own.
    const p = probes({ api: true, p2p: true, address: [null, null, OWN] })

    expect(await checkBeePorts(p)).toEqual({ kind: 'own' })
    expect(p.sleep).toHaveBeenCalledTimes(2)
  })

  it('calls an unidentifiable holder foreign after the retries', async () => {
    expect(await checkBeePorts(probes({ api: true, p2p: false, address: null }))).toEqual({
      kind: 'foreign',
      port: 1633,
      address: null,
    })
  })

  it('flags something holding only the p2p port', async () => {
    expect(await checkBeePorts(probes({ api: false, p2p: true, address: null }))).toEqual({
      kind: 'foreign',
      port: 1634,
      address: null,
    })
  })

  it('treats ports that free up during the checks as free', async () => {
    expect(await checkBeePorts(probes({ api: [true, false], p2p: [true, false], address: null }))).toEqual({
      kind: 'free',
    })
  })
})
