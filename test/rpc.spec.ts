import {
  COOLDOWN_MS,
  endpointOrder,
  isAutomaticRpc,
  isRetryableAnswer,
  relayJsonRpc,
  resetFailover,
  RPC_FALLBACK,
  RPC_PRIMARY,
} from '../src/rpc'

jest.mock('../src/logger', () => ({ logger: { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() } }))
jest.mock('../src/config', () => ({ readConfigYaml: jest.fn(() => ({})) }))

const CALL = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] })
const TX = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_sendRawTransaction', params: ['0x00'] })
const OK = JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x10' })

type Reply = { status: number; body: string } | Error
const fetchMock = jest.fn()

function replies(byUrl: Record<string, Reply[]>) {
  fetchMock.mockImplementation(async (url: string) => {
    const next = byUrl[url]?.shift()

    if (!next) throw new Error(`unexpected call to ${url}`)

    if (next instanceof Error) throw next

    return { status: next.status, text: async () => next.body, headers: new Map([['content-type', 'application/json']]) }
  })
}

function timeout(): Error {
  const e = new Error('timed out')

  e.name = 'TimeoutError'

  return e
}

beforeAll(() => {
  global.fetch = fetchMock as unknown as typeof fetch
})

beforeEach(() => {
  fetchMock.mockReset()
  resetFailover()
})

describe('isAutomaticRpc', () => {
  it.each([undefined, '', 'http://127.0.0.1:3054/rpc'])('%p means Nook picks the RPC', value => {
    expect(isAutomaticRpc(value)).toBe(true)
  })

  // R6-1: old defaults are moved to the relay once by the migration; after
  // that the same URL is a custom RPC the user chose.
  it.each(['https://rpc.gnosischain.com', 'https://xdai.fairdatasociety.org', 'https://my.rpc'])(
    '%s is a custom RPC',
    value => {
      expect(isAutomaticRpc(value)).toBe(false)
    },
  )
})

describe('isRetryableAnswer', () => {
  it('fails over on 429 and 5xx', () => {
    expect(isRetryableAnswer(429, '')).toBe(true)
    expect(isRetryableAnswer(503, '')).toBe(true)
  })

  it('keeps ordinary answers, including JSON-RPC errors that are not throttling', () => {
    expect(isRetryableAnswer(200, OK)).toBe(false)
    expect(isRetryableAnswer(200, JSON.stringify({ error: { code: -32000, message: 'nonce too low' } }))).toBe(false)
    expect(isRetryableAnswer(400, 'bad request')).toBe(false)
  })

  it('fails over on throttling reported inside a 200 (single and batch)', () => {
    expect(isRetryableAnswer(200, JSON.stringify({ error: { code: -32005, message: 'x' } }))).toBe(true)
    expect(isRetryableAnswer(200, JSON.stringify([{ result: 1 }, { error: { message: 'Too Many Requests' } }]))).toBe(
      true,
    )
  })

  it("fails over when one provider can't serve the request (publicnode's getLogs range cap)", () => {
    expect(
      isRetryableAnswer(200, JSON.stringify({ error: { code: -32701, message: 'exceed maximum block range: 50000' } })),
    ).toBe(true)
  })

  it('treats a non-JSON 200 (captive portal) as a failure', () => {
    expect(isRetryableAnswer(200, '<html>login</html>')).toBe(true)
  })
})

describe('relayJsonRpc', () => {
  it('uses the primary when it answers', async () => {
    replies({ [RPC_PRIMARY]: [{ status: 200, body: OK }] })
    const res = await relayJsonRpc(CALL)

    expect(res.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('retries on the fallback when the primary throttles, then prefers the fallback for the cooldown', async () => {
    const now = 1_000_000

    replies({ [RPC_PRIMARY]: [{ status: 429, body: 'slow down' }], [RPC_FALLBACK]: [{ status: 200, body: OK }] })
    const res = await relayJsonRpc(CALL, now)

    expect(res.body).toBe(OK)
    expect(endpointOrder(now + 1)).toEqual([RPC_FALLBACK, RPC_PRIMARY])
    expect(endpointOrder(now + COOLDOWN_MS + 1)).toEqual([RPC_PRIMARY, RPC_FALLBACK])
  })

  it('fails over when the primary is unreachable', async () => {
    replies({ [RPC_PRIMARY]: [new TypeError('fetch failed')], [RPC_FALLBACK]: [{ status: 200, body: OK }] })
    expect((await relayJsonRpc(CALL)).body).toBe(OK)
  })

  it("returns the last endpoint's answer when both fail", async () => {
    replies({ [RPC_PRIMARY]: [{ status: 429, body: 'a' }], [RPC_FALLBACK]: [{ status: 503, body: 'b' }] })
    const res = await relayJsonRpc(CALL)

    expect(res.status).toBe(503)
  })

  it('answers 502 when neither endpoint is reachable', async () => {
    replies({ [RPC_PRIMARY]: [new TypeError('x')], [RPC_FALLBACK]: [new TypeError('y')] })
    const res = await relayJsonRpc(CALL)

    expect(res.status).toBe(502)
    expect(JSON.parse(res.body).error.message).toMatch(/unreachable/)
  })

  it('goes back to the primary when it answers during a cooldown', async () => {
    const now = 1_000_000

    replies({ [RPC_PRIMARY]: [{ status: 429, body: '' }], [RPC_FALLBACK]: [{ status: 200, body: OK }] })
    await relayJsonRpc(CALL, now)
    // During the cooldown the fallback is tried first; it fails, the primary works.
    replies({ [RPC_FALLBACK]: [{ status: 503, body: '' }], [RPC_PRIMARY]: [{ status: 200, body: OK }] })
    await relayJsonRpc(CALL, now + 1000)
    expect(endpointOrder(now + 2000)).toEqual([RPC_PRIMARY, RPC_FALLBACK])
  })

  describe('transactions are never sent twice when their fate is unknown', () => {
    it('retries a transaction the primary refused with 429', async () => {
      replies({ [RPC_PRIMARY]: [{ status: 429, body: '' }], [RPC_FALLBACK]: [{ status: 200, body: OK }] })
      expect((await relayJsonRpc(TX)).body).toBe(OK)
    })

    it('does not retry a transaction after a 5xx', async () => {
      replies({ [RPC_PRIMARY]: [{ status: 502, body: 'gw' }] })
      const res = await relayJsonRpc(TX)

      expect(res.status).toBe(502)
      expect(fetchMock).toHaveBeenCalledTimes(1)
    })

    it('does not retry a transaction after a timeout', async () => {
      replies({ [RPC_PRIMARY]: [timeout()] })
      const res = await relayJsonRpc(TX)

      expect(res.status).toBe(502)
      expect(fetchMock).toHaveBeenCalledTimes(1)
    })
  })
})
