import { readFileSync } from 'fs'
import { join } from 'path'
import { isBeeAssetReady } from './downloader'
import { type AutoExtendFailure, getAutoExtendFailures } from './extend-monitor'
import { BeeMode, type FundingState, getFundingState, getMode } from './funding-monitor'
import { BeeManager } from './lifecycle'
import { getSupervisorStatus } from './supervisor'
import { type ForeignBee, getForeignBee } from './foreign-bee'
import { reserveJustBoughtAt } from './system-stamp'
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
  /** Outstanding auto-extend failures (#129) — the UI banner keys on these. */
  autoExtendFailures: AutoExtendFailure[]
  /** What the funding monitor last saw (R5-15) — onboarding's funding step. */
  funding: FundingState
  /** Another Bee node holds Nook's ports (R5-11) — the dashboard blocks on this. */
  foreignBee: ForeignBee | null
  /** The messaging reserve was just bought and may not be listed by Bee yet (F-6). */
  reserveBoughtAt: number | null
}

export function getStatus() {
  const status: Status = {
    assetsReady: isBeeAssetReady(),
    mode: getMode(),
    userStopped: BeeManager.wasEverStarted() && !BeeManager.shouldRestart(),
    crashLoop: getSupervisorStatus().crashLoop,
    autoExtendFailures: getAutoExtendFailures(),
    funding: getFundingState(),
    foreignBee: getForeignBee(),
    reserveBoughtAt: reserveJustBoughtAt(),
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
