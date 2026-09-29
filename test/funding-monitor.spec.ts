import { checkFundingNow, startMonitorIfNeeded } from '../src/funding-monitor'
import { runLauncher } from '../src/launcher'

// Every balance read waits until the test releases it, so two checks can be
// in flight at once — the race the guard in switchToLightMode closes.
const pendingBalances: Array<(wei: bigint) => void> = []

jest.mock('ethers', () => {
  const actual = jest.requireActual('ethers')

  return {
    ...actual,
    providers: {
      StaticJsonRpcProvider: jest.fn().mockImplementation(() => ({
        getBalance: async () =>
          new Promise(resolve => pendingBalances.push(wei => resolve(actual.BigNumber.from(wei.toString())))),
      })),
    },
  }
})
jest.mock('fs', () => ({
  ...jest.requireActual('fs'),
  readFileSync: jest.fn(() => JSON.stringify({ address: 'ab'.repeat(20) })),
}))
jest.mock('../src/config', () => ({
  readConfigYaml: jest.fn(() => ({ 'swap-enable': false })),
  writeConfigYaml: jest.fn(),
}))
jest.mock('../src/path', () => ({ checkPath: jest.fn(() => true), getPath: jest.fn((p: string) => p) }))
jest.mock('../src/launcher', () => ({ runLauncher: jest.fn(async (): Promise<void> => undefined) }))
jest.mock('../src/lifecycle', () => ({
  BeeManager: { stop: jest.fn(), waitForSigtermToFinish: jest.fn(async (): Promise<void> => undefined) },
}))
jest.mock('../src/chequebook-monitor', () => ({ onLightModeSwitch: jest.fn() }))
jest.mock('../src/rpc', () => ({
  isAutomaticRpc: () => true,
  nookRpcUrl: () => 'http://127.0.0.1:3054/rpc',
  RPC_RELAY_URL: 'http://127.0.0.1:3054/rpc',
}))
jest.mock('../src/logger', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }))

const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

describe('funding monitor', () => {
  it('switches to light mode once when the poll and "check now" both see the funds', async () => {
    jest.useFakeTimers()
    startMonitorIfNeeded()

    // The 15 s poll starts a balance read…
    jest.advanceTimersByTime(15_000)
    await flush()
    // …and the user presses "check now" while it is still waiting.
    const manual = checkFundingNow()
    await flush()
    expect(pendingBalances).toHaveLength(2)

    const oneXdai = BigInt('1000000000000000000')
    pendingBalances.forEach(release => release(oneXdai))
    await manual
    await flush()

    expect(runLauncher).toHaveBeenCalledTimes(1)
    jest.useRealTimers()
  })
})
