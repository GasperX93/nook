import Router from '@koa/router'
import Wallet from 'ethereumjs-wallet'
import { readFile } from 'fs/promises'
import Koa from 'koa'
import koaBodyparser from 'koa-bodyparser'
import mount from 'koa-mount'
import serve from 'koa-static'
import fetch from 'node-fetch'
import * as path from 'path'

import { ethers } from 'ethers'

import PACKAGE_JSON from '../package.json'
import { getApiKey } from './api-key'
import { redeemGiftCode } from './blockchain'
import { readConfigYaml, readWalletPasswordOrThrow, writeConfigYaml } from './config'
import { runLauncher } from './launcher'
import { BeeManager } from './lifecycle'
import { logger, readBeeDesktopLogs, readBeeLogs, subscribeLogServerRequests } from './logger'
import { getPath } from './path'
import { port } from './port'
import { getStatus } from './status'
import { swap } from './swap'

const UI_DIST = path.join(__dirname, '..', '..', 'ui')

const AUTO_UPDATE_ENABLED_PLATFORMS = ['darwin', 'win32']

export function runServer() {
  const app = new Koa()
  logger.info(`Serving UI from path: ${UI_DIST}`)
  app.use(mount('/dashboard', serve(UI_DIST)))

  app.use(async (context, next) => {
    const corsOrigin = process.env.NODE_ENV === 'development' ? '*' : `http://localhost:${port.value}`
    context.set('Access-Control-Allow-Origin', corsOrigin)
    context.set('Access-Control-Allow-Credentials', 'true')
    context.set(
      'Access-Control-Allow-Headers',
      'Content-Type, Content-Length, Authorization, Accept, X-Requested-With, Referer, Baggage',
    )
    context.set('Access-Control-Allow-Methods', 'POST, GET, PUT, DELETE, OPTIONS')
    await next()
  })

  app.use(koaBodyparser({ onerror: logger.error }))
  const router = new Router()

  // Open endpoints without any authentication
  router.get('/info', context => {
    context.body = {
      name: 'bee-desktop',
      version: PACKAGE_JSON.version,
      autoUpdateEnabled: AUTO_UPDATE_ENABLED_PLATFORMS.includes(process.platform),
    }
  })
  router.get('/price', async context => {
    try {
      const response = await fetch('https://tokenservice.ethswarm.org/token_price')
      context.body = await response.text()
    } catch (error) {
      logger.error(error)
      context.status = 503
      context.body = { message: 'Failed to fetch price from token service', error }
    }
  })

  router.use(async (context, next) => {
    const { authorization } = context.headers

    if (authorization !== getApiKey()) {
      context.status = 401
      context.body = 'Unauthorized'

      return
    }
    await next()
  })

  // Authenticated endpoints
  router.get('/status', context => {
    context.body = getStatus()
  })
  router.get('/peers', async context => {
    try {
      const beePassword = readConfigYaml().password as string
      const response = await fetch('http://127.0.0.1:1633/peers', {
        headers: { Authorization: `Bearer ${beePassword}` },
      })
      const { peers } = await response.json()

      context.body = { connections: peers ? peers.length || 0 : 0 }
    } catch (error) {
      logger.error(error)
      context.body = { connections: 0 }
    }
  })
  router.post('/config', context => {
    writeConfigYaml(context.request.body as Record<string, string>)
    context.body = readConfigYaml()
  })
  router.get('/config', context => {
    context.body = readConfigYaml()
  })
  router.get('/logs/bee-desktop', async context => {
    context.body = await readBeeDesktopLogs()
  })
  router.get('/logs/bee', async context => {
    try {
      context.body = await readBeeLogs()
    } catch (e) {
      // Bee might not be started and hence the logs might not be available
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        context.status = 400

        return
      }

      throw e
    }
  })
  router.post('/restart', async context => {
    BeeManager.stop()
    await BeeManager.waitForSigtermToFinish()
    runLauncher()
    context.body = { success: true }
  })
  router.post('/redeem', async context => {
    const { giftCode } = context.request.body as { giftCode: string }

    if (!giftCode) {
      context.status = 400
      context.body = { message: 'giftCode is required' }

      return
    }
    const config = readConfigYaml()
    const blockchainRpcEndpoint = Reflect.get(config, 'blockchain-rpc-endpoint') as string
    const beePassword = Reflect.get(config, 'password') as string
    try {
      const addrRes = await fetch('http://127.0.0.1:1633/addresses', {
        headers: { Authorization: `Bearer ${beePassword}` },
      })
      const { ethereum: nodeAddress } = (await addrRes.json()) as { ethereum: string }
      await redeemGiftCode(giftCode, nodeAddress, blockchainRpcEndpoint)
      context.body = { success: true }
    } catch (error) {
      logger.error(error)
      context.status = 500
      context.body = { message: 'Failed to redeem gift code', error }
    }
  })
  router.post('/feed-update', async context => {
    const { topicHex, reference, stampId } = context.request.body as {
      topicHex: string
      reference: string
      stampId: string
    }

    if (!topicHex || !reference || !stampId) {
      context.status = 400
      context.body = { message: 'topicHex, reference, and stampId are required' }

      return
    }
    try {
      const feedManifestAddress = await createFeedUpdate(topicHex, reference, stampId)
      context.body = { feedManifestAddress }
    } catch (error) {
      logger.error(error)
      context.status = 500
      context.body = { message: 'Feed update failed', error }
    }
  })
  router.post('/buy-stamp', async context => {
    const { amount, depth, immutable, label } = context.request.body as {
      amount: string
      depth: number
      immutable: boolean
      label?: string
    }

    if (!amount || !depth) {
      context.status = 400
      context.body = { message: 'amount and depth are required' }

      return
    }

    try {
      const beePassword = readConfigYaml().password as string
      const qs = label ? `?label=${encodeURIComponent(label)}` : ''
      const res = await fetch(`http://127.0.0.1:1633/stamps/${amount}/${depth}${qs}`, {
        method: 'POST',
        headers: {
          immutable: String(Boolean(immutable)),
          ...(beePassword ? { Authorization: `Bearer ${beePassword}` } : {}),
        },
      })
      const data = (await res.json()) as { batchID: string }

      if (!res.ok) {
        context.status = res.status
        context.body = data

        return
      }

      context.body = data
    } catch (error) {
      logger.error(error)
      context.status = 500
      context.body = { message: 'Failed to buy stamp', error }
    }
  })

  router.post('/swap', async context => {
    const config = readConfigYaml()
    const blockchainRpcEndpoint = Reflect.get(config, 'blockchain-rpc-endpoint') as string
    const privateKeyString = await getPrivateKey()
    try {
      await swap(privateKeyString, (context.request.body as Record<string, string>).dai, '10000', blockchainRpcEndpoint)
      context.body = { success: true }
    } catch (error) {
      logger.error(error)
      context.status = 500
      context.body = { message: 'Failed to swap', error }
    }
  })

  app.use(router.routes())
  app.use(router.allowedMethods())
  const server = app.listen(port.value)
  subscribeLogServerRequests(server)
}

// ─── SOC / Feed helpers ───────────────────────────────────────────────────────

function socKeccak256(data: Uint8Array): Uint8Array {
  return ethers.utils.arrayify(ethers.utils.keccak256(data))
}

function socConcat(...arrays: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(arrays.reduce((s, a) => s + a.length, 0))
  let off = 0

  for (const a of arrays) {
    out.set(a, off)
    off += a.length
  }

  return out
}

function uint64BE(n: number): Uint8Array {
  const b = new Uint8Array(8)

  new DataView(b.buffer).setBigUint64(0, BigInt(n), false)

  return b
}

function uint64LE(n: number): Uint8Array {
  const b = new Uint8Array(8)

  new DataView(b.buffer).setBigUint64(0, BigInt(n), true)

  return b
}

/** Binary Merkle Tree root hash — matches bee-js bmtRootHash() */
function bmtRootHash(payload: Uint8Array): Uint8Array {
  let input = new Uint8Array(4096)

  input.set(payload)

  while (input.length !== 32) {
    const output = new Uint8Array(input.length / 2)

    for (let off = 0; off < input.length; off += 64) {
      output.set(socKeccak256(input.slice(off, off + 64)), off / 2)
    }

    input = output
  }

  return input
}

/** CAC address — matches bee-js bmtHash(span||payload) */
function cacAddress(span: Uint8Array, payload: Uint8Array): Uint8Array {
  return socKeccak256(socConcat(span, bmtRootHash(payload)))
}

/**
 * Create a Swarm feed update (signed SOC) and upload it to the Bee node.
 * Mirrors what swarm-cli / bee-js do internally.
 * Returns the permanent feed manifest address (hex, no 0x).
 */
async function createFeedUpdate(topicHex: string, referenceHex: string, stampId: string): Promise<string> {
  const privateKeyHex = await getPrivateKey()
  const wallet = new ethers.Wallet(privateKeyHex)
  const owner = wallet.address.toLowerCase().replace('0x', '')

  const beeUrl = 'http://127.0.0.1:1633'
  const beePassword = readConfigYaml().password as string | undefined
  const authHeader: Record<string, string> = beePassword ? { Authorization: `Bearer ${beePassword}` } : {}

  // Determine next feed index (0 for first ever update)
  let nextIndex = 0

  try {
    const res = await fetch(`${beeUrl}/feeds/${owner}/${topicHex}?type=sequence`, { headers: authHeader })

    if (res.ok) {
      const data = (await res.json()) as { feedIndexNext: string }

      nextIndex = parseInt(data.feedIndexNext, 16)
    }
  } catch {
    // first update — index stays 0
  }

  // Identifier = keccak256(topic || index_uint64_be)
  const topicBytes = ethers.utils.arrayify('0x' + topicHex.replace(/^0x/, ''))
  const identifier = socKeccak256(socConcat(topicBytes, uint64BE(nextIndex)))

  // Payload = timestamp_uint64_be(8) + reference(32)
  const payload = socConcat(
    uint64BE(Math.floor(Date.now() / 1000)),
    ethers.utils.arrayify('0x' + referenceHex.replace(/^0x/, '')),
  )

  // Span = little-endian uint64 of payload length (always 40)
  const span = uint64LE(40)

  // Signing digest = keccak256(identifier || cacAddress(span||payload))
  const digest = socKeccak256(socConcat(identifier, cacAddress(span, payload)))

  // Sign with Ethereum personal-sign prefix (\x19Ethereum Signed Message:\n32)
  const sigHex = await wallet.signMessage(digest)

  // SOC body = span(8) + payload(40) — identifier and sig go in URL/params
  const socBody = socConcat(span, payload)
  const identifierHex = ethers.utils.hexlify(identifier).slice(2)
  const sigQueryHex = sigHex.slice(2)

  const socRes = await fetch(`${beeUrl}/soc/${owner}/${identifierHex}?sig=${sigQueryHex}`, {
    method: 'POST',
    headers: {
      ...authHeader,
      'swarm-postage-batch-id': stampId,
      'swarm-deferred-upload': 'false',
      'Content-Type': 'application/octet-stream',
    },
    body: Buffer.from(socBody),
  })

  if (!socRes.ok) {
    const text = await socRes.text().catch(() => '')

    throw new Error(`SOC upload failed: ${socRes.status} ${text}`)
  }

  // Create/fetch the permanent feed manifest address
  const manifestRes = await fetch(`${beeUrl}/feeds/${owner}/${topicHex}`, {
    method: 'POST',
    headers: { ...authHeader, 'swarm-postage-batch-id': stampId },
  })

  if (!manifestRes.ok) throw new Error(`Feed manifest failed: ${manifestRes.status}`)

  const { reference } = (await manifestRes.json()) as { reference: string }

  return reference
}

async function getPrivateKey(): Promise<string> {
  const v3 = await readFile(getPath(path.join('data-dir', 'keys', 'swarm.key')), 'utf-8')
  const wallet = await Wallet.fromV3(v3, readWalletPasswordOrThrow())
  const privateKeyString = wallet.getPrivateKeyString()

  return privateKeyString
}
