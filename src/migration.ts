import { existsSync, renameSync, unlinkSync } from 'fs'
import { configYamlExists, deleteKeyFromConfigYaml, readConfigYaml, writeConfigYaml } from './config'
import { getLogPath, getPath } from './path'
import { isAutomaticRpc, RPC_RELAY_URL } from './rpc-endpoints'

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
  // to a second public RPC when the first throttles (R5-3/R5-14). A custom
  // RPC the user chose stays untouched. Only for installs that already have
  // an RPC set — new ultra-light installs get one when funding switches them.
  const rpc = config['blockchain-rpc-endpoint']

  if (typeof rpc === 'string' && rpc !== RPC_RELAY_URL && isAutomaticRpc(rpc)) {
    writeConfigYaml({ 'blockchain-rpc-endpoint': RPC_RELAY_URL })
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
