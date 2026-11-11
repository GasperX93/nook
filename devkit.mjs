#!/usr/bin/env node

import envPaths from 'env-paths'
import open from 'open'

import cpy from 'cpy'
import { execSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * `.npmrc` sets ignore-scripts, so no dependency runs code at install time.
 * These are the only ones whose install script Nook needs:
 *   electron            — downloads the Electron binary
 *   better-sqlite3      — fetches/compiles its native module
 *   electron-winstaller — picks the 7-Zip binary (Windows installer)
 *   fs-xattr, macos-alias — native modules for the macOS DMG
 * Adding a name here lets that package run code on every developer and CI
 * machine — check what its script does first.
 */
const INSTALL_SCRIPT_PACKAGES = ['electron', 'better-sqlite3', 'electron-winstaller', 'fs-xattr', 'macos-alias']

const paths = envPaths('Nook', { suffix: '' })
const requestedCommand = process.argv[2]

switch (requestedCommand) {
  case 'open:ui':
    await openUi()
    break
  case 'copy:ui':
    await copyUi()
    break
  case 'purge:data':
    await purgeData()
    break
  case 'purge:logs':
    await purgeLogs()
    break
  case 'install:scripts':
    runInstallScripts()
    break
  default:
    throw new Error(`Unknown command "${requestedCommand}"!`)
}

function runInstallScripts() {
  // Always the main app's node_modules, wherever this is run from: an empty
  // list would turn the command into "rebuild everything, scripts on".
  const root = import.meta.dirname
  // Optional packages are only installed on the system they are for.
  const present = INSTALL_SCRIPT_PACKAGES.filter(name => existsSync(join(root, 'node_modules', name)))

  if (present.length === 0) {
    throw new Error('No package to run install scripts for — run `npm ci` first')
  }
  execSync(`npm rebuild ${present.join(' ')} --ignore-scripts=false`, { cwd: root, stdio: 'inherit' })
}

function purgeData() {
  return rm(paths.data, { recursive: true, force: true })
}

function purgeLogs() {
  return rm(paths.log, { recursive: true, force: true })
}

async function copyUi() {
  // Clear the destination first — Vite emits hash-named chunks, so without this
  // each build's chunks pile up on top of the previous one's, accumulating dead
  // files in dist/ui and bloating the packaged app.asar unbounded across builds.
  await rm(join('dist', 'ui'), { recursive: true, force: true })

  return cpy('.', join('..', '..', 'dist', 'ui'), { cwd: join('ui', 'build') })
}

async function openUi() {
  const apiKey = await readFile(join(paths.data, 'api-key.txt'), { encoding: 'utf-8' })
  const url = `http://localhost:3002/?v=${apiKey}#/`

  console.log('Opening: ' + url)
  await open(url)
}
