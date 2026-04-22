import Router from '@koa/router'
import { Bee } from '@ethersphere/bee-js'
import Wallet from 'ethereumjs-wallet'
import { readFile } from 'fs/promises'
import Koa from 'koa'
import koaBodyparser from 'koa-bodyparser'
import mount from 'koa-mount'
import serve from 'koa-static'
import * as path from 'path'

import { ethers } from 'ethers'

import PACKAGE_JSON from '../package.json'
import { getApiKey } from './api-key'
import { redeemGiftCode, sendBzzTransaction, sendNativeTransaction } from './blockchain'
import { readConfigYaml, readWalletPasswordOrThrow, writeConfigYaml } from './config'
import { runLauncher } from './launcher'
import { BeeManager } from './lifecycle'
import { logger, readNookLogs, readBeeLogs, subscribeLogServerRequests } from './logger'
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

  // Pass-through proxy: /bee-api/* → http://127.0.0.1:1633/*
  // Mirrors the Vite dev proxy so renderer code can use `${origin}/bee-api`
  // unchanged in both dev (Vite, port 3002) and prod (Koa, port 3054). Without
  // this, anything using bee-js from the renderer 404s on the prod path.
  // Registered before bodyparser so the request body stream stays intact.
  app.use(async (context, next) => {
    if (!context.path.startsWith('/bee-api')) {
      await next()

      return
    }
    const beePath = context.path.replace(/^\/bee-api/, '')
    const url = `http://127.0.0.1:1633${beePath}${context.search || ''}`
    const headers: Record<string, string> = {}

    for (const [k, v] of Object.entries(context.headers)) {
      if (typeof v === 'string') headers[k.toLowerCase()] = v
    }
    // Strip headers Koa / fetch will recompute or that confuse Bee
    delete headers.host
    delete headers['content-length']
    delete headers.connection
    delete headers['accept-encoding']
    const hasBody = ['POST', 'PUT', 'PATCH'].includes(context.method)
    // Buffer the request body — avoids edge cases with streaming + duplex: 'half'
    let body: Uint8Array | undefined

    if (hasBody) {
      const chunks: Buffer[] = []

      for await (const chunk of context.req) chunks.push(chunk as Buffer)
      body = chunks.length > 0 ? new Uint8Array(Buffer.concat(chunks)) : undefined
    }

    try {
      const res = await fetch(url, { method: context.method, headers, body: body as BodyInit | undefined })

      context.status = res.status
      // Forward response headers EXCEPT CORS (Koa CORS middleware adds those —
      // duplicating causes browsers to fail with "Network Error" even on 2xx)
      // and EXCEPT transfer encodings Koa will recompute.
      res.headers.forEach((value, key) => {
        if (key === 'content-length' || key === 'transfer-encoding' || key === 'connection') return

        // fetch() auto-decompresses; forwarding content-encoding makes the browser
        // try to decode plain bytes → ERR_CONTENT_DECODING_FAILED
        if (key === 'content-encoding') return

        if (key.startsWith('access-control-')) return
        context.set(key, value)
      })
      // Buffer response too — Bee API responses are small enough and this
      // avoids Web Stream / Node Stream conversion issues
      context.body = Buffer.from(await res.arrayBuffer())
    } catch (e) {
      logger.error(`bee-api proxy failed for ${url}: ${(e as Error).message}`)
      context.status = 502
      context.body = { error: 'Bee node unreachable' }
    }
  })

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
      name: 'nook',
      version: PACKAGE_JSON.version,
      autoUpdateEnabled: AUTO_UPDATE_ENABLED_PLATFORMS.includes(process.platform),
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
      const peers = await makeBee().getPeers()

      context.body = { connections: peers.length }
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
  router.get('/logs/nook', async context => {
    context.body = await readNookLogs()
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
    const blockchainRpcEndpoint =
      (Reflect.get(config, 'blockchain-rpc-endpoint') as string) || 'https://rpc.gnosischain.com'
    try {
      const { ethereum: nodeAddress } = await makeBee().getNodeAddresses()
      await redeemGiftCode(giftCode, nodeAddress.toString(), blockchainRpcEndpoint)
      context.body = { success: true }
    } catch (error) {
      logger.error(error)
      const msg = (error as Error).message ?? ''
      let friendly = 'Failed to redeem gift code'

      if (msg.includes('REPLACEMENT_UNDERPRICED') || msg.includes('replacement transaction underpriced')) {
        friendly = 'A previous transaction is still pending. Please wait a moment and try again.'
      } else if (msg.includes('NONCE_EXPIRED') || msg.includes('nonce too low')) {
        friendly = 'A previous transaction just completed. Please try again.'
      } else if (msg.includes('INSUFFICIENT_FUNDS') || msg.includes('insufficient funds')) {
        friendly = 'Gift wallet has insufficient funds to cover gas fees.'
      } else if (msg) {
        friendly = msg
      }
      context.status = 500
      context.body = { message: friendly }
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
      context.body = {
        message: 'Could not publish the feed update. Check that your stamp has storage left and try again.',
      }
    }
  })
  router.get('/feed-read', async context => {
    const topicHex = context.query.topic as string
    const owner = context.query.owner as string

    if (!topicHex || !owner) {
      context.status = 400
      context.body = { message: 'topic and owner query params are required' }

      return
    }

    try {
      const bee = makeBee()
      const reader = bee.makeFeedReader(topicHex, owner)
      const result = await reader.downloadReference()
      const data = await bee.downloadData(result.reference.toHex())
      context.type = 'application/octet-stream'
      context.body = Buffer.from(data.toUint8Array())
    } catch (error) {
      logger.error(error)
      context.status = 404
      context.body = { message: 'Feed not found' }
    }
  })

  router.post('/upload-bytes', async context => {
    const { stampId, data } = context.request.body as { stampId: string; data: string }

    if (!stampId || !data) {
      context.status = 400
      context.body = { message: 'stampId and data are required' }

      return
    }

    try {
      const bee = makeBee()
      const result = await bee.uploadData(stampId, data)
      context.body = { reference: result.reference.toHex() }
    } catch (error) {
      logger.error(error)
      context.status = 500
      context.body = { message: 'Upload failed' }
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
      const batchID = await makeBee().createPostageBatch(amount, depth, { immutableFlag: Boolean(immutable), label })
      context.body = { batchID: batchID.toString() }
    } catch (error) {
      logger.error(error)
      context.status = 500
      const beeMessage: string = (error as any)?.responseBody?.message ?? ''
      const errString = String(error)
      let message: string

      if (beeMessage.toLowerCase().includes('syncing')) {
        message = 'Your node is still syncing with the network. This can take a few minutes — please try again shortly.'
      } else if (errString.includes('ECONNREFUSED') || errString.includes('fetch failed')) {
        message = 'Your node is still starting up. Please wait a moment and try again.'
      } else {
        message = 'Failed to create drive. Please try again.'
      }
      context.body = { message }
    }
  })

  // ─── ACT proxy endpoints ──────────────────────────────────────────────────
  // Bee ACT endpoints require Bearer auth. We proxy them so the browser UI
  // doesn't need the Bee password. Downloads are also proxied because the
  // browser strips custom headers (swarm-act-*) on cross-origin requests.

  router.post('/act/upload-metadata', async context => {
    const { stampId, data, historyRef } = context.request.body as {
      stampId: string
      data: string // JSON string
      historyRef?: string
    }

    if (!stampId || !data) {
      context.status = 400
      context.body = { message: 'stampId and data are required' }

      return
    }

    try {
      const beePassword = readConfigYaml().password as string | undefined
      const headers: Record<string, string> = {
        'swarm-postage-batch-id': stampId,
        'swarm-deferred-upload': 'true',
        'swarm-act': 'true',
        'Content-Type': 'application/octet-stream',
      }

      if (historyRef) headers['swarm-act-history-address'] = historyRef

      if (beePassword) headers.Authorization = `Bearer ${beePassword}`

      const response = await fetch('http://127.0.0.1:1633/bytes', {
        method: 'POST',
        headers,
        body: Buffer.from(data, 'utf-8'),
      })

      if (!response.ok) {
        context.status = response.status
        context.body = { message: `ACT upload failed: ${response.statusText}` }

        return
      }

      const result = (await response.json()) as { reference: string }
      const actHistory = response.headers.get('swarm-act-history-address')
      context.body = {
        reference: result.reference,
        historyRef: actHistory ?? '',
      }
    } catch (error) {
      logger.error(error)
      context.status = 500
      context.body = { message: 'ACT metadata upload failed' }
    }
  })

  router.get('/act/download/:hash', async context => {
    const { hash } = context.params
    const actPublisher = context.query.publisher as string
    const actHistoryRef = context.query.history as string

    if (!actPublisher || !actHistoryRef) {
      context.status = 400
      context.body = { message: 'publisher and history query params are required' }

      return
    }

    try {
      const beePassword = readConfigYaml().password as string | undefined
      const headers: Record<string, string> = {
        'swarm-act': 'true',
        'swarm-act-publisher': actPublisher,
        'swarm-act-history-address': actHistoryRef,
      }

      if (beePassword) headers.Authorization = `Bearer ${beePassword}`

      // Try /bzz first (files/collections), then /bytes (raw data like metadata)
      let response = await fetch(`http://127.0.0.1:1633/bzz/${hash}/`, { headers, redirect: 'follow' })

      if (!response.ok) {
        response = await fetch(`http://127.0.0.1:1633/bytes/${hash}`, { headers })
      }

      if (!response.ok) {
        context.status = response.status
        context.body = { message: `ACT download failed: ${response.statusText}` }

        return
      }

      const buffer = await response.arrayBuffer()
      const contentType = response.headers.get('content-type')

      if (contentType) context.type = contentType
      context.body = Buffer.from(buffer)
    } catch (error) {
      logger.error(error)
      context.status = 500
      context.body = { message: 'ACT download failed' }
    }
  })

  router.post('/grantee', async context => {
    const { stampId, grantees, historyRef } = context.request.body as {
      stampId: string
      grantees: string[]
      historyRef?: string
    }

    if (!stampId || !grantees?.length) {
      context.status = 400
      context.body = { message: 'stampId and grantees are required' }

      return
    }

    try {
      const beePassword = readConfigYaml().password as string | undefined
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'swarm-postage-batch-id': stampId,
      }

      if (historyRef) headers['swarm-act-history-address'] = historyRef

      if (beePassword) headers.Authorization = `Bearer ${beePassword}`

      const response = await fetch('http://127.0.0.1:1633/grantee', {
        method: 'POST',
        headers,
        body: JSON.stringify({ grantees }),
      })

      if (!response.ok) {
        const errBody = await response.text().catch(() => '')
        logger.error(`Create grantees failed: ${response.status} ${errBody}`)
        context.status = response.status
        context.body = { message: 'Failed to create grantee list' }

        return
      }

      const result = (await response.json()) as { ref: string; historyref: string }
      const actHistory = response.headers.get('swarm-act-history-address')
      context.body = {
        ref: result.ref,
        historyRef: actHistory ?? result.historyref ?? '',
      }
    } catch (error) {
      logger.error(error)
      context.status = 500
      context.body = { message: 'Failed to create grantee list' }
    }
  })

  router.get('/grantee/:ref', async context => {
    const { ref } = context.params

    try {
      const bee = makeBee()
      const result = await bee.getGrantees(ref)
      context.body = { grantees: result.grantees.map(String) }
    } catch (error) {
      logger.error(error)
      context.status = 500
      context.body = { message: 'Failed to get grantees' }
    }
  })

  router.patch('/grantee/:ref', async context => {
    const { ref } = context.params
    const { stampId, historyRef, add, revoke } = context.request.body as {
      stampId: string
      historyRef: string
      add?: string[]
      revoke?: string[]
    }

    if (!stampId || !historyRef) {
      context.status = 400
      context.body = { message: 'stampId and historyRef are required' }

      return
    }

    try {
      const bee = makeBee()
      const result = await bee.patchGrantees(stampId, ref, historyRef, { add, revoke })
      context.body = {
        ref: result.ref.toString(),
        historyRef: result.historyref.toString(),
      }
    } catch (error) {
      logger.error(error)
      context.status = 500
      context.body = { message: 'Failed to update grantees' }
    }
  })

  router.post('/withdraw', async context => {
    const { token, amount, to } = context.request.body as { token: string; amount: string; to: string }

    if (!token || !amount || !to) {
      context.status = 400
      context.body = { message: 'token, amount, and to are required' }

      return
    }

    if (!ethers.utils.isAddress(to)) {
      context.status = 400
      context.body = { message: 'Invalid destination address' }

      return
    }

    const config = readConfigYaml()
    const blockchainRpcEndpoint =
      (Reflect.get(config, 'blockchain-rpc-endpoint') as string) || 'https://rpc.gnosischain.com'
    const privateKeyString = await getPrivateKey()

    try {
      const result =
        token === 'bzz'
          ? await sendBzzTransaction(privateKeyString, to, amount, blockchainRpcEndpoint)
          : await sendNativeTransaction(privateKeyString, to, amount, blockchainRpcEndpoint)

      context.body = { success: true, txHash: result.transaction.hash }
    } catch (error) {
      logger.error(error)
      const msg = (error as Error).message ?? ''
      let friendly = 'Withdraw failed'

      if (msg.includes('REPLACEMENT_UNDERPRICED') || msg.includes('replacement transaction underpriced')) {
        friendly = 'A previous transaction is still pending. Please wait a moment and try again.'
      } else if (msg.includes('INSUFFICIENT_FUNDS') || msg.includes('insufficient funds')) {
        friendly = 'Insufficient funds to cover gas fees.'
      } else if (msg.includes('UNPREDICTABLE_GAS_LIMIT')) {
        friendly = 'Transaction failed — make sure no other Bee node is running on the same port.'
      } else if (msg) {
        friendly = msg
      }
      context.status = 500
      context.body = { message: friendly }
    }
  })

  router.post('/chequebook-withdraw', async context => {
    const { amount } = context.request.body as { amount: string }

    if (!amount) {
      context.status = 400
      context.body = { message: 'amount is required' }

      return
    }

    try {
      const result = await makeBee().getChequebookBalance()
      const available = result.availableBalance.toPLURBigInt()
      const requested = BigInt(amount)

      if (requested > available) {
        context.status = 400
        context.body = { message: 'Insufficient chequebook balance' }

        return
      }

      const beePassword = readConfigYaml().password as string | undefined
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }

      if (beePassword) headers.Authorization = `Bearer ${beePassword}`

      const res = await fetch(`http://127.0.0.1:1633/chequebook/withdraw?amount=${amount}`, {
        method: 'POST',
        headers,
      })

      if (!res.ok) {
        const text = await res.text()
        throw new Error(text || `Bee returned ${res.status}`)
      }

      const data = await res.json()
      context.body = { success: true, transactionHash: data.transactionHash }
    } catch (error) {
      logger.error(error)
      context.status = 500
      context.body = { message: (error as Error).message || 'Failed to withdraw from chequebook' }
    }
  })

  router.post('/swap', async context => {
    const config = readConfigYaml()
    const blockchainRpcEndpoint =
      (Reflect.get(config, 'blockchain-rpc-endpoint') as string) || 'https://rpc.gnosischain.com'
    const privateKeyString = await getPrivateKey()
    try {
      await swap(privateKeyString, (context.request.body as Record<string, string>).dai, '10000', blockchainRpcEndpoint)
      context.body = { success: true }
    } catch (error) {
      logger.error(error)
      const msg = (error as Error).message ?? ''
      let friendly = 'Failed to swap'

      if (msg.includes('REPLACEMENT_UNDERPRICED') || msg.includes('replacement transaction underpriced')) {
        friendly = 'A previous transaction is still pending. Please wait a moment and try again.'
      } else if (msg.includes('INSUFFICIENT_FUNDS') || msg.includes('insufficient funds')) {
        friendly = 'Insufficient funds to cover gas fees.'
      } else if (msg.includes('UNPREDICTABLE_GAS_LIMIT')) {
        friendly = 'Transaction failed — make sure no other Bee node is running on the same port.'
      } else if (msg) {
        friendly = msg
      }
      context.status = 500
      context.body = { message: friendly }
    }
  })

  app.use(router.routes())
  app.use(router.allowedMethods())
  const server = app.listen(port.value)
  subscribeLogServerRequests(server)
}

/**
 * Create a Swarm feed update using bee-js (the reference implementation).
 * Returns the permanent feed manifest address (hex, no 0x).
 */
async function createFeedUpdate(topicHex: string, referenceHex: string, stampId: string): Promise<string> {
  const privateKeyHex = await getPrivateKey()
  const wallet = new ethers.Wallet(privateKeyHex)

  const bee = makeBee()

  // bee-js v11: pass private key directly, no custom signer needed
  const writer = bee.makeFeedWriter(topicHex, privateKeyHex)
  await writer.upload(stampId, referenceHex)

  const manifest = await bee.createFeedManifest(stampId, topicHex, wallet.address)

  return manifest.toString()
}

function makeBee(): Bee {
  const beePassword = readConfigYaml().password as string | undefined
  const requestOptions = beePassword ? { headers: { Authorization: `Bearer ${beePassword}` } } : {}

  return new Bee('http://127.0.0.1:1633', requestOptions)
}

async function getPrivateKey(): Promise<string> {
  const v3 = await readFile(getPath(path.join('data-dir', 'keys', 'swarm.key')), 'utf-8')
  const wallet = await Wallet.fromV3(v3, readWalletPasswordOrThrow())
  const privateKeyString = wallet.getPrivateKeyString()

  return privateKeyString
}
