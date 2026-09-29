import { mayLaunchBee } from '../src/foreign-bee'
import { runLauncher } from '../src/launcher'

jest.mock('../src/electron', () => ({ rebuildElectronTray: jest.fn() }))
jest.mock('../src/foreign-bee', () => ({ mayLaunchBee: jest.fn() }))
jest.mock('../src/path', () => ({
  checkPath: jest.fn(() => true),
  getPath: jest.fn((p: string) => p),
  getLogPath: jest.fn((p: string) => p),
}))
jest.mock('../src/logger', () => ({ logger: { info: jest.fn(), debug: jest.fn(), error: jest.fn() } }))

const mockMay = mayLaunchBee as jest.Mock

describe('runLauncher', () => {
  it('runs one port check at a time — overlapping calls do not launch twice', async () => {
    let release: (v: boolean) => void = () => undefined
    mockMay.mockImplementation(async () => new Promise<boolean>(r => (release = r)))

    const first = runLauncher()
    const second = runLauncher() // e.g. a keep-alive tick during the slow check
    release(false) // ports held by another node: no launch
    await Promise.all([first, second])

    expect(mockMay).toHaveBeenCalledTimes(1)
  })

  it('checks again once the previous check finished', async () => {
    mockMay.mockReset()
    mockMay.mockResolvedValue(false)
    await runLauncher()
    await runLauncher()

    expect(mockMay).toHaveBeenCalledTimes(2)
  })
})
