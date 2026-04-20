import { getStatus } from '../src/status'
import { getMode, getNeedsFunding } from '../src/funding-monitor'
import { isBeeAssetReady } from '../src/downloader'
import { checkPath } from '../src/path'
import { readConfigYaml } from '../src/config'

jest.mock('../src/funding-monitor', () => ({
  getMode: jest.fn(),
  getNeedsFunding: jest.fn(),
}))

jest.mock('../src/downloader', () => ({
  isBeeAssetReady: jest.fn(),
}))

jest.mock('../src/path', () => ({
  checkPath: jest.fn(),
  getPath: jest.fn((p: string) => `/mock/${p}`),
}))

jest.mock('../src/config', () => ({
  readConfigYaml: jest.fn(),
}))

jest.mock('fs', () => ({
  readFileSync: jest.fn(() => JSON.stringify({ address: 'deadbeef' })),
}))

const mockGetMode = getMode as jest.Mock
const mockGetNeedsFunding = getNeedsFunding as jest.Mock
const mockAssetsReady = isBeeAssetReady as jest.Mock
const mockCheckPath = checkPath as jest.Mock
const mockReadConfig = readConfigYaml as jest.Mock

beforeEach(() => {
  jest.clearAllMocks()
})

describe('getStatus', () => {
  it('includes needsFunding: false when wallet is funded', () => {
    mockGetMode.mockReturnValue('light')
    mockGetNeedsFunding.mockReturnValue(false)
    mockAssetsReady.mockReturnValue(true)
    mockCheckPath.mockReturnValue(false)

    const status = getStatus()
    expect(status).toHaveProperty('needsFunding', false)
    expect(status).toHaveProperty('mode', 'light')
    expect(status).toHaveProperty('assetsReady', true)
  })

  it('includes needsFunding: true when wallet has no xDAI in light mode', () => {
    mockGetMode.mockReturnValue('light')
    mockGetNeedsFunding.mockReturnValue(true)
    mockAssetsReady.mockReturnValue(true)
    mockCheckPath.mockReturnValue(false)

    const status = getStatus()
    expect(status).toHaveProperty('needsFunding', true)
    expect(status).toHaveProperty('mode', 'light')
  })

  it('includes config and address when config.yaml and data-dir exist', () => {
    mockGetMode.mockReturnValue('light')
    mockGetNeedsFunding.mockReturnValue(false)
    mockAssetsReady.mockReturnValue(true)
    mockCheckPath.mockReturnValue(true)
    mockReadConfig.mockReturnValue({ 'swap-enable': true })

    const status = getStatus()
    expect(status).toHaveProperty('config', { 'swap-enable': true })
    expect(status).toHaveProperty('address', 'deadbeef')
  })

  it('omits config and address when config.yaml does not exist', () => {
    mockGetMode.mockReturnValue('ultra-light')
    mockGetNeedsFunding.mockReturnValue(false)
    mockAssetsReady.mockReturnValue(false)
    mockCheckPath.mockReturnValue(false)

    const status = getStatus()
    expect(status.config).toBeUndefined()
    expect(status.address).toBeUndefined()
  })
})
