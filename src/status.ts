import { readFileSync } from 'fs'
import { join } from 'path'
import { isBeeAssetReady } from './downloader'
import { BeeMode, getMode } from './funding-monitor'
import { BeeManager } from './lifecycle'
import { getSupervisorStatus } from './supervisor'
import { checkPath, getPath } from './path'
import { readConfigYaml } from './config'

interface Status {
  address?: string
  config?: Record<string, any>
  assetsReady: boolean
  mode: BeeMode
  /** True when the user intentionally stopped Bee via the tray menu. */
  userStopped: boolean
  /** True when Bee crashed repeatedly and the supervisor gave up restarting (#94). */
  crashLoop: boolean
}

export function getStatus() {
  const status: Status = {
    assetsReady: isBeeAssetReady(),
    mode: getMode(),
    userStopped: BeeManager.wasEverStarted() && !BeeManager.shouldRestart(),
    crashLoop: getSupervisorStatus().crashLoop,
  }

  if (!checkPath('config.yaml') || !checkPath('data-dir')) {
    return status
  }

  status.config = readConfigYaml()
  status.address = readEthereumAddress()

  return status
}

function readEthereumAddress() {
  const path = getPath(join('data-dir', 'keys', 'swarm.key'))
  const swarmKeyFile = readFileSync(path, 'utf-8')
  const v3 = JSON.parse(swarmKeyFile)

  return v3.address
}
