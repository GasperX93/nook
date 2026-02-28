import { deleteKeyFromConfigYaml, readConfigYaml, writeConfigYaml, configYamlExists } from '../src/config'
import { runMigrations } from '../src/migration'

jest.mock('../src/config', () => ({
  configYamlExists: jest.fn(),
  readConfigYaml: jest.fn(),
  writeConfigYaml: jest.fn(),
  deleteKeyFromConfigYaml: jest.fn(),
}))

const mockExists = configYamlExists as jest.Mock
const mockRead = readConfigYaml as jest.Mock
const mockWrite = writeConfigYaml as jest.Mock
const mockDelete = deleteKeyFromConfigYaml as jest.Mock

beforeEach(() => {
  jest.clearAllMocks()
})

describe('runMigrations', () => {
  describe('when config does not exist', () => {
    it('does nothing', () => {
      mockExists.mockReturnValue(false)
      runMigrations()
      expect(mockRead).not.toHaveBeenCalled()
      expect(mockWrite).not.toHaveBeenCalled()
      expect(mockDelete).not.toHaveBeenCalled()
    })
  })

  describe('legacy key removal', () => {
    it('removes skip-postage-snapshot when present', () => {
      mockExists.mockReturnValue(true)
      mockRead.mockReturnValue({ 'skip-postage-snapshot': true, 'use-postage-snapshot': false })
      runMigrations()
      expect(mockDelete).toHaveBeenCalledWith('skip-postage-snapshot')
    })

    it('removes chain-enable when present', () => {
      mockExists.mockReturnValue(true)
      mockRead.mockReturnValue({ 'chain-enable': true, 'use-postage-snapshot': false })
      runMigrations()
      expect(mockDelete).toHaveBeenCalledWith('chain-enable')
    })

    it('removes block-hash when present', () => {
      mockExists.mockReturnValue(true)
      mockRead.mockReturnValue({ 'block-hash': 'abc123', 'use-postage-snapshot': false })
      runMigrations()
      expect(mockDelete).toHaveBeenCalledWith('block-hash')
    })

    it('removes transaction when present', () => {
      mockExists.mockReturnValue(true)
      mockRead.mockReturnValue({ transaction: 'txhash', 'use-postage-snapshot': false })
      runMigrations()
      expect(mockDelete).toHaveBeenCalledWith('transaction')
    })

    it('removes admin-password when present', () => {
      mockExists.mockReturnValue(true)
      mockRead.mockReturnValue({ 'admin-password': 'secret', 'use-postage-snapshot': false })
      runMigrations()
      expect(mockDelete).toHaveBeenCalledWith('admin-password')
    })

    it('removes debug-api-addr when present', () => {
      mockExists.mockReturnValue(true)
      mockRead.mockReturnValue({ 'debug-api-addr': ':1635', 'use-postage-snapshot': false })
      runMigrations()
      expect(mockDelete).toHaveBeenCalledWith('debug-api-addr')
    })

    it('removes debug-api-enable when present', () => {
      mockExists.mockReturnValue(true)
      mockRead.mockReturnValue({ 'debug-api-enable': true, 'use-postage-snapshot': false })
      runMigrations()
      expect(mockDelete).toHaveBeenCalledWith('debug-api-enable')
    })

    it('does not delete keys that are absent', () => {
      mockExists.mockReturnValue(true)
      mockRead.mockReturnValue({ 'use-postage-snapshot': false, 'blockchain-rpc-endpoint': 'http://x', 'storage-incentives-enable': false })
      runMigrations()
      expect(mockDelete).not.toHaveBeenCalled()
    })
  })

  describe('blockchain-rpc-endpoint migration', () => {
    it('migrates swap-endpoint to blockchain-rpc-endpoint when missing', () => {
      mockExists.mockReturnValue(true)
      mockRead.mockReturnValue({ 'swap-endpoint': 'https://rpc.example.com', 'use-postage-snapshot': false })
      runMigrations()
      expect(mockWrite).toHaveBeenCalledWith({ 'blockchain-rpc-endpoint': 'https://rpc.example.com' })
    })

    it('does not overwrite existing blockchain-rpc-endpoint with swap-endpoint', () => {
      mockExists.mockReturnValue(true)
      mockRead.mockReturnValue({
        'swap-endpoint': 'https://old.rpc',
        'blockchain-rpc-endpoint': 'https://existing.rpc',
        'use-postage-snapshot': false,
      })
      runMigrations()
      expect(mockWrite).not.toHaveBeenCalledWith({ 'blockchain-rpc-endpoint': 'https://old.rpc' })
    })

    it('sets default blockchain-rpc-endpoint when both are absent', () => {
      mockExists.mockReturnValue(true)
      mockRead.mockReturnValue({ 'use-postage-snapshot': false })
      runMigrations()
      expect(mockWrite).toHaveBeenCalledWith({
        'blockchain-rpc-endpoint': 'https://xdai.fairdatasociety.org',
      })
    })

    it('does not set default when blockchain-rpc-endpoint already exists', () => {
      mockExists.mockReturnValue(true)
      mockRead.mockReturnValue({ 'blockchain-rpc-endpoint': 'https://my.rpc', 'use-postage-snapshot': false })
      runMigrations()
      expect(mockWrite).not.toHaveBeenCalledWith({
        'blockchain-rpc-endpoint': 'https://xdai.fairdatasociety.org',
      })
    })
  })

  describe('swap-enable migration', () => {
    it('sets swap-enable to true when it is the string "false"', () => {
      mockExists.mockReturnValue(true)
      mockRead.mockReturnValue({ 'swap-enable': 'false', 'blockchain-rpc-endpoint': 'http://x', 'use-postage-snapshot': false })
      runMigrations()
      expect(mockWrite).toHaveBeenCalledWith({ 'swap-enable': true })
    })

    it('sets swap-enable to true when it is the boolean false', () => {
      mockExists.mockReturnValue(true)
      mockRead.mockReturnValue({ 'swap-enable': false, 'blockchain-rpc-endpoint': 'http://x', 'use-postage-snapshot': false })
      runMigrations()
      expect(mockWrite).toHaveBeenCalledWith({ 'swap-enable': true })
    })

    it('does not touch swap-enable when already true', () => {
      mockExists.mockReturnValue(true)
      mockRead.mockReturnValue({ 'swap-enable': true, 'blockchain-rpc-endpoint': 'http://x', 'use-postage-snapshot': false })
      runMigrations()
      expect(mockWrite).not.toHaveBeenCalledWith({ 'swap-enable': true })
    })
  })

  describe('use-postage-snapshot migration', () => {
    it('sets use-postage-snapshot to false when not already false', () => {
      mockExists.mockReturnValue(true)
      mockRead.mockReturnValue({ 'blockchain-rpc-endpoint': 'http://x' })
      runMigrations()
      expect(mockWrite).toHaveBeenCalledWith({ 'use-postage-snapshot': false })
    })

    it('does not write use-postage-snapshot when already false (boolean)', () => {
      mockExists.mockReturnValue(true)
      mockRead.mockReturnValue({ 'blockchain-rpc-endpoint': 'http://x', 'use-postage-snapshot': false })
      runMigrations()
      expect(mockWrite).not.toHaveBeenCalledWith({ 'use-postage-snapshot': false })
    })

    it('does not write use-postage-snapshot when already the string "false"', () => {
      mockExists.mockReturnValue(true)
      mockRead.mockReturnValue({ 'blockchain-rpc-endpoint': 'http://x', 'use-postage-snapshot': 'false' })
      runMigrations()
      expect(mockWrite).not.toHaveBeenCalledWith({ 'use-postage-snapshot': false })
    })
  })

  describe('storage-incentives-enable default', () => {
    it('sets storage-incentives-enable to false when absent', () => {
      mockExists.mockReturnValue(true)
      mockRead.mockReturnValue({ 'blockchain-rpc-endpoint': 'http://x', 'use-postage-snapshot': false })
      runMigrations()
      expect(mockWrite).toHaveBeenCalledWith({ 'storage-incentives-enable': false })
    })

    it('does not overwrite existing storage-incentives-enable', () => {
      mockExists.mockReturnValue(true)
      mockRead.mockReturnValue({ 'blockchain-rpc-endpoint': 'http://x', 'use-postage-snapshot': false, 'storage-incentives-enable': false })
      runMigrations()
      expect(mockWrite).not.toHaveBeenCalledWith({ 'storage-incentives-enable': false })
    })
  })
})
