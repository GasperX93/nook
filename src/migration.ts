import { existsSync, renameSync, unlinkSync } from 'fs'
import { configYamlExists, deleteKeyFromConfigYaml, readConfigYaml, writeConfigYaml } from './config'
import { getLogPath, getPath } from './path'

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

  // Only upgrade old RPC for existing users who already have one set — don't add it for new ultra-light installs
  if (config['blockchain-rpc-endpoint'] === 'https://xdai.fairdatasociety.org') {
    writeConfigYaml({ 'blockchain-rpc-endpoint': 'https://rpc.gnosischain.com' })
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

  if (config['use-postage-snapshot'] !== false && config['use-postage-snapshot'] !== 'false') {
    writeConfigYaml({ 'use-postage-snapshot': false })
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
