import { existsSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from 'fs'
import { dirname } from 'path'
import { configYamlExists, deleteKeyFromConfigYaml, readConfigYaml, writeConfigYaml } from './config'
import { logger } from './logger'
import { getLogPath, getPath } from './path'
import { LEGACY_DEFAULT_RPCS, RPC_RELAY_URL } from './rpc-endpoints'

/** Written once the legacy-RPC → relay move has run (R6-1). */
const RPC_RELAY_MARKER = '.rpc-relay-migrated'

function markRpcMoveDone() {
  const marker = getPath(RPC_RELAY_MARKER)

  try {
    mkdirSync(dirname(marker), { recursive: true })
    writeFileSync(marker, '')
  } catch (error) {
    // Worst case the move runs again next start — same result as today.
    logger.error('migration: could not write the RPC relay marker', error)
  }
}

function migrateFile(oldPath: string, newPath: string) {
  const oldExists = existsSync(oldPath)
  const newExists = existsSync(newPath)

  if (oldExists && !newExists) {
    renameSync(oldPath, newPath)
  } else if (oldExists && newExists) {
    unlinkSync(oldPath)
  }
}

export function runMigrations() {
  // Rename legacy files from swarm-desktop era
  migrateFile(getPath('desktop.version'), getPath('nook.version'))
  migrateFile(getLogPath('bee-desktop.log'), getLogPath('nook.log'))

  if (!configYamlExists()) {
    // Fresh install: nothing legacy to move, so the one-time RPC move is done
    // — a URL the user picks in the first session must survive the restart.
    markRpcMoveDone()

    return
  }

  const config = readConfigYaml()

  if (config['skip-postage-snapshot'] !== false && config['skip-postage-snapshot'] !== 'false') {
    writeConfigYaml({ 'skip-postage-snapshot': false })
  }

  if (config['storage-incentives-enable'] === undefined) {
    writeConfigYaml({ 'storage-incentives-enable': false })
  }

  if (config['swap-endpoint'] && !config['blockchain-rpc-endpoint']) {
    writeConfigYaml({ 'blockchain-rpc-endpoint': config['swap-endpoint'] })
  }

  // Route installs still on a default Nook once wrote (rpc.gnosischain.com,
  // or the older fairdatasociety one) through the RPC relay, which falls back
  // to a second public RPC when the first throttles (R5-3/R5-14). Runs ONCE:
  // afterwards the same URL in the config is a custom RPC the user picked in
  // Settings and must be kept (R6-1). Installs without an RPC yet (ultra-light)
  // get the relay when funding switches them.
  const rpcMarker = getPath(RPC_RELAY_MARKER)

  if (!existsSync(rpcMarker)) {
    // The swap-endpoint move above may just have written the RPC (the
    // config snapshot predates it).
    const rpc = config['blockchain-rpc-endpoint'] || config['swap-endpoint']

    if (typeof rpc === 'string' && LEGACY_DEFAULT_RPCS.includes(rpc)) {
      writeConfigYaml({ 'blockchain-rpc-endpoint': RPC_RELAY_URL })
    }

    markRpcMoveDone()
  }

  // Cloudflare deprecated its Ethereum gateway: it still answers the handshake
  // (eth_chainId) but fails every real query (eth_call → -32603), so ENS
  // resolution silently broke. Move existing installs to a working public RPC.
  if (config['resolver-options'] === 'https://cloudflare-eth.com') {
    writeConfigYaml({ 'resolver-options': 'https://ethereum-rpc.publicnode.com' })
  }

  if (config['chain-enable'] !== undefined) {
    deleteKeyFromConfigYaml('chain-enable')
  }

  if (config['block-hash'] !== undefined) {
    deleteKeyFromConfigYaml('block-hash')
  }

  if (config.transaction !== undefined) {
    deleteKeyFromConfigYaml('transaction')
  }

  if (config['swap-endpoint'] !== undefined) {
    deleteKeyFromConfigYaml('swap-endpoint')
  }

  // Removed in Bee v2.7.1 — delete if present
  if (config['use-postage-snapshot'] !== undefined) {
    deleteKeyFromConfigYaml('use-postage-snapshot')
  }

  if (config['admin-password'] !== undefined) {
    deleteKeyFromConfigYaml('admin-password')
  }

  if (config['debug-api-addr'] !== undefined) {
    deleteKeyFromConfigYaml('debug-api-addr')
  }

  if (config['debug-api-enable'] !== undefined) {
    deleteKeyFromConfigYaml('debug-api-enable')
  }
}
