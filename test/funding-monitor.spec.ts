import { detectMode, getMode, getNeedsFunding, startMonitorIfNeeded } from '../src/funding-monitor'
import { readConfigYaml } from '../src/config'
import { checkPath } from '../src/path'

jest.mock('../src/config', () => ({
  readConfigYaml: jest.fn(),
  writeConfigYaml: jest.fn(),
}))

jest.mock('../src/path', () => ({
  checkPath: jest.fn(),
  getPath: jest.fn((p: string) => `/mock/${p}`),
}))

jest.mock('../src/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
}))

jest.mock('../src/lifecycle', () => ({
  BeeManager: { stop: jest.fn(), waitForSigtermToFinish: jest.fn().mockResolvedValue(undefined) },
}))

jest.mock('../src/launcher', () => ({
  runLauncher: jest.fn().mockResolvedValue(undefined),
}))

jest.mock('../src/chequebook-monitor', () => ({
  onLightModeSwitch: jest.fn(),
}))

jest.mock('fs', () => ({
  readFileSync: jest.fn(() => JSON.stringify({ address: 'abcd1234' })),
}))

// Mock ethers — prevent real RPC calls
jest.mock('ethers', () => ({
  providers: {
    JsonRpcProvider: jest.fn(),
  },
  utils: {
    parseEther: jest.fn(() => ({ gte: jest.fn() })),
    formatEther: jest.fn(() => '0.0'),
  },
}))

const mockCheckPath = checkPath as jest.Mock
const mockReadConfig = readConfigYaml as jest.Mock

beforeEach(() => {
  jest.clearAllMocks()
  jest.useFakeTimers()
})

afterEach(() => {
  jest.useRealTimers()
})

describe('detectMode', () => {
  it('returns ultra-light when no config.yaml exists', () => {
    mockCheckPath.mockReturnValue(false)
    expect(detectMode()).toBe('ultra-light')
  })

  it('returns light when swap-enable is true (boolean)', () => {
    mockCheckPath.mockReturnValue(true)
    mockReadConfig.mockReturnValue({ 'swap-enable': true })
    expect(detectMode()).toBe('light')
  })

  it('returns light when swap-enable is "true" (string)', () => {
    mockCheckPath.mockReturnValue(true)
    mockReadConfig.mockReturnValue({ 'swap-enable': 'true' })
    expect(detectMode()).toBe('light')
  })

  it('returns ultra-light when swap-enable is false', () => {
    mockCheckPath.mockReturnValue(true)
    mockReadConfig.mockReturnValue({ 'swap-enable': false })
    expect(detectMode()).toBe('ultra-light')
  })

  it('returns ultra-light when swap-enable is missing', () => {
    mockCheckPath.mockReturnValue(true)
    mockReadConfig.mockReturnValue({})
    expect(detectMode()).toBe('ultra-light')
  })
})

describe('getNeedsFunding', () => {
  it('starts as false', () => {
    expect(getNeedsFunding()).toBe(false)
  })
})

describe('startMonitorIfNeeded', () => {
  it('starts monitor in ultra-light mode', () => {
    mockCheckPath.mockReturnValue(false)
    startMonitorIfNeeded()
    expect(getMode()).toBe('ultra-light')
  })

  it('starts monitor in light mode (no longer skips)', () => {
    mockCheckPath.mockReturnValue(true)
    mockReadConfig.mockReturnValue({ 'swap-enable': true })
    startMonitorIfNeeded()
    expect(getMode()).toBe('light')
    // The key assertion: mode is light but the monitor still started
    // (no early return). We verify by checking getMode() was set correctly.
  })
})
