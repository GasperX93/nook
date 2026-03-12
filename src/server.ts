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
      } else if (msg) {
        friendly = msg
      }
      context.status = 500
      context.body = { message: friendly }
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
