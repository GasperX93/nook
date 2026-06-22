#!/usr/bin/env node

import envPaths from 'env-paths'
import open from 'open'

import cpy from 'cpy'
import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'

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
  default:
    throw new Error(`Unknown command "${requestedCommand}"!`)
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
