import { mayLaunchBee } from '../src/foreign-bee'
import { runKeepAliveLoop } from '../src/launcher'
import { BeeManager } from '../src/lifecycle'

jest.mock('../src/electron', () => ({ rebuildElectronTray: jest.fn() }))
jest.mock('../src/foreign-bee', () => ({ mayLaunchBee: jest.fn(async () => false) }))
jest.mock('../src/lifecycle', () => ({
  BeeManager: {
    isRunning: jest.fn(() => false),
    shouldRestart: jest.fn(() => false),
    setUserIntention: jest.fn(),
    signalRunning: jest.fn(),
    signalStopped: jest.fn(),
    kill: jest.fn(),
  },
}))
jest.mock('../src/supervisor', () => ({
  canAttemptStart: jest.fn(() => true),
  recordStart: jest.fn(),
  recordExit: jest.fn(),
  shouldRestartForWedge: jest.fn(async () => false),
}))
jest.mock('../src/path', () => ({
  checkPath: jest.fn(() => true),
  getPath: jest.fn((p: string) => p),
  getLogPath: jest.fn((p: string) => p),
}))
jest.mock('../src/logger', () => ({ logger: { info: jest.fn(), debug: jest.fn(), error: jest.fn() } }))

const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

describe('keep-alive loop (F-1)', () => {
  beforeEach(() => {
    jest.useFakeTimers()
    jest.clearAllMocks()
  })
  afterEach(() => jest.useRealTimers())

  it('keeps checking the ports while the user has stopped Nook’s node — without starting it', async () => {
    runKeepAliveLoop()
    jest.advanceTimersByTime(10_000)
    await flush()
    jest.advanceTimersByTime(10_000)
    await flush()

    // A foreign node that appears meanwhile is detected (mayLaunchBee records it)…
    expect(mayLaunchBee).toHaveBeenCalledTimes(2)
    // …but the user's "stopped" choice stands: nothing is launched.
    expect(BeeManager.setUserIntention).not.toHaveBeenCalled()
    expect(BeeManager.signalRunning).not.toHaveBeenCalled()
  })
})
