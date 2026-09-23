import { Contract, providers, utils, Wallet } from 'ethers'
import { bzzContractInterface } from './contract'

export async function sendNativeTransaction(
  privateKey: string,
  to: string,
  value: string,
  blockchainRpcEndpoint: string,
) {
  const signer = await makeReadySigner(privateKey, blockchainRpcEndpoint)
  const gasPrice = await signer.getGasPrice()
  const transaction = await signer.sendTransaction({ to, value, gasPrice })
  const receipt = await transaction.wait(1)

  return { transaction, receipt }
}

export async function sendBzzTransaction(privateKey: string, to: string, value: string, blockchainRpcEndpoint: string) {
  const signer = await makeReadySigner(privateKey, blockchainRpcEndpoint)
  const gasPrice = await signer.getGasPrice()
  const bzz = new Contract('0xdBF3Ea6F5beE45c02255B2c26a16F300502F68da', bzzContractInterface, signer)
  const transaction = await bzz.transfer(to, value, { gasPrice })
  const receipt = await transaction.wait(1)

  return { transaction, receipt }
}

/** swarm-notify on-chain registry on Gnosis — the ONLY contract the node key pings. */
export const NOTIFY_REGISTRY_ADDRESS = '0x318aE190B77bA39fbcdFA4e84BB7CFD16b846Fcf'

/** Selector of notify(bytes32,bytes) — the ONLY function the node key may call there. */
const NOTIFY_SELECTOR = utils.id('notify(bytes32,bytes)').slice(0, 10)

/** Calldata ceiling: an ECIES-encrypted sender/name payload is a few hundred bytes. */
const MAX_NOTIFY_CALLDATA_BYTES = 4096

/** True when `data` is well-formed calldata for registry.notify(bytes32,bytes). */
export function isNotifyCalldata(data: unknown): data is string {
  return (
    typeof data === 'string' &&
    /^0x([0-9a-fA-F]{2})+$/.test(data) &&
    data.toLowerCase().startsWith(NOTIFY_SELECTOR) &&
    (data.length - 2) / 2 <= MAX_NOTIFY_CALLDATA_BYTES
  )
}

/**
 * Send a first-contact ping (swarm-notify registry.notify) signed by the node
 * key, so messaging needs no external wallet. Bee signs its own transactions
 * with the same key, so a concurrent Bee transaction can take our nonce —
 * retry once on a nonce clash. Resolves after one confirmation.
 */
export async function sendRegistryNotification(privateKey: string, data: string, blockchainRpcEndpoint: string) {
  if (!isNotifyCalldata(data)) throw new Error('Not a registry notify call')

  const signer = await makeReadySigner(privateKey, blockchainRpcEndpoint)

  for (let attempt = 1; ; attempt++) {
    try {
      const gasPrice = await signer.getGasPrice()
      const transaction = await signer.sendTransaction({ to: NOTIFY_REGISTRY_ADDRESS, data, gasPrice })
      const receipt = await transaction.wait(1)

      return { transaction, receipt }
    } catch (error) {
      const message = String((error as { message?: string })?.message ?? error)
      const nonceClash = /nonce|replacement transaction underpriced|already known/i.test(message)

      if (attempt >= 2 || !nonceClash) throw error
    }
  }
}

export async function redeemGiftCode(giftCode: string, toAddress: string, blockchainRpcEndpoint: string) {
  const provider = new providers.JsonRpcProvider(blockchainRpcEndpoint, 100)
  await provider.ready
  const giftWallet = new Wallet(giftCode, provider)
  const gasPrice = await provider.getGasPrice()

  // Transfer all BZZ
  const bzz = new Contract('0xdBF3Ea6F5beE45c02255B2c26a16F300502F68da', bzzContractInterface, giftWallet)
  const bzzBalance = await bzz.balanceOf(giftWallet.address)

  const gasLimit = 21000
  const gasCost = gasPrice.mul(gasLimit)

  // Check initial xDAI balance for empty-code detection
  const xdaiBalanceInitial = await provider.getBalance(giftWallet.address)

  if (bzzBalance.isZero() && xdaiBalanceInitial.lte(gasCost)) {
    throw new Error('Gift code is empty or has already been redeemed.')
  }

  if (bzzBalance.gt(0)) {
    const tx = await bzz.transfer(toAddress, bzzBalance, { gasPrice })
    await tx.wait(1)
  }

  // Re-fetch xDAI balance after BZZ transfer (BZZ tx consumed some xDAI for gas)
  const xdaiBalanceAfterBzz = await provider.getBalance(giftWallet.address)
  const xdaiToSend = xdaiBalanceAfterBzz.sub(gasCost)

  if (xdaiToSend.gt(0)) {
    const tx = await giftWallet.sendTransaction({ to: toAddress, value: xdaiToSend, gasPrice, gasLimit })
    await tx.wait(1)
  }
}

async function makeReadySigner(privateKey: string, blockchainRpcEndpoint: string) {
  const provider = new providers.JsonRpcProvider(blockchainRpcEndpoint, 100)
  await provider.ready
  const signer = new Wallet(privateKey, provider)

  return signer
}
