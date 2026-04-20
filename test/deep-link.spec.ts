import { extractSwarmUrl, handleSwarmUrl, markDeepLinkReady } from '../src/deep-link'

jest.mock('electron', () => ({
  app: {
    setAsDefaultProtocolClient: jest.fn(),
    on: jest.fn(),
  },
  shell: {
    openExternal: jest.fn(),
  },
}))

jest.mock('../src/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
}))

const mockOpenWithShare = jest.fn()
jest.mock('../src/browser', () => ({
  openDashboardWithShareLink: (...args: unknown[]) => mockOpenWithShare(...args),
}))

beforeEach(() => {
  jest.clearAllMocks()
})

describe('extractSwarmUrl', () => {
  it('extracts swarm:// URL from argv', () => {
    const argv = ['/path/to/nook', '--some-flag', 'swarm://feed?topic=abc&owner=def&publisher=ghi']
    expect(extractSwarmUrl(argv)).toBe('swarm://feed?topic=abc&owner=def&publisher=ghi')
  })

  it('returns null when no swarm URL present', () => {
    expect(extractSwarmUrl(['/path/to/nook'])).toBeNull()
  })

  it('returns null for empty argv', () => {
    expect(extractSwarmUrl([])).toBeNull()
  })

  it('ignores non-swarm protocols', () => {
    expect(extractSwarmUrl(['http://example.com', 'ftp://files.com'])).toBeNull()
  })

  it('returns the first swarm URL if multiple are present', () => {
    const argv = ['swarm://first', 'swarm://second']
    expect(extractSwarmUrl(argv)).toBe('swarm://first')
  })
})

describe('handleSwarmUrl + markDeepLinkReady', () => {
  // These tests must run in order because they share module-level state
  // (ready flag, pendingUrl). Jest runs them sequentially within a describe.

  it('queues URL before ready and flushes on markDeepLinkReady', () => {
    handleSwarmUrl('swarm://feed?topic=abc&owner=def&publisher=ghi')
    // Not ready yet, so should not open
    expect(mockOpenWithShare).not.toHaveBeenCalled()

    const result = markDeepLinkReady()
    expect(result).toBe(true)
    expect(mockOpenWithShare).toHaveBeenCalledWith('swarm://feed?topic=abc&owner=def&publisher=ghi')
  })

  it('returns false when no pending URL', () => {
    // ready is now true from previous test, no pending URL
    mockOpenWithShare.mockClear()
    expect(markDeepLinkReady()).toBe(false)
    expect(mockOpenWithShare).not.toHaveBeenCalled()
  })

  it('opens immediately when already ready', () => {
    // ready is true from the first test
    mockOpenWithShare.mockClear()
    handleSwarmUrl('swarm://feed?topic=x&owner=y&publisher=z')
    expect(mockOpenWithShare).toHaveBeenCalledWith('swarm://feed?topic=x&owner=y&publisher=z')
  })

  it('ignores non-swarm URLs', () => {
    mockOpenWithShare.mockClear()
    handleSwarmUrl('http://example.com')
    expect(mockOpenWithShare).not.toHaveBeenCalled()
  })
})
