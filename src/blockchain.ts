import { BigNumber, Contract, providers, utils, Wallet } from 'ethers'
import { bzzContractInterface } from './contract'

// ── Fees (F-2) ──────────────────────────────────────────────────────────────
// Gnosis base fees can sit at ~20 wei, and eth_gasPrice answers base + 1 wei.
// Sending that as the fee cap (what ethers does with `gasPrice`) leaves the
// validator nothing the moment the base fee ticks up — nodes reject it:
// "EffectivePriorityFeePerGas too low 0 < 1". So every transaction Nook
// sends sets EIP-1559 fees itself: a real tip, and a cap with headroom.

/** Smallest tip Nook pays — 1 gwei ≈ 0.00002 xDAI for a plain transfer. */
export const MIN_PRIORITY_FEE = utils.parseUnits('1', 'gwei')

export interface FeeOverrides {
  type: 2
  maxFeePerGas: BigNumber
  maxPriorityFeePerGas: BigNumber
}

/** Fees from the latest base fee and the node's suggested tip (pure — tested). */
export function feesFrom(baseFee: BigNumber, suggestedTip: BigNumber | null): FeeOverrides {
  const tip = suggestedTip && suggestedTip.gt(MIN_PRIORITY_FEE) ? suggestedTip : MIN_PRIORITY_FEE

  return { type: 2, maxPriorityFeePerGas: tip, maxFeePerGas: baseFee.mul(2).add(tip) }
}

export async function feeOverrides(provider: providers.JsonRpcProvider): Promise<FeeOverrides> {
  const block = await provider.getBlock('latest')
  const baseFee = block.baseFeePerGas ?? (await provider.getGasPrice())
  let suggested: BigNumber | null = null

  try {
    suggested = BigNumber.from(await provider.send('eth_maxPriorityFeePerGas', []))
  } catch {
    // Not every RPC answers this — the minimum tip is plenty on Gnosis.
  }

  return feesFrom(baseFee, suggested)
}

/** A readable message for a failed chain transaction, or null to keep the caller's own. */
export function friendlyChainError(message: string): string | null {
  if (/FeeTooLow|fee too low|max fee per gas less than block base fee/i.test(message)) {
    return 'The network fee changed while sending — please try again.'
  }

  return null
}

export async function sendNativeTransaction(
  privateKey: string,
  to: string,
  value: string,
  blockchainRpcEndpoint: string,
) {
  const signer = await makeReadySigner(privateKey, blockchainRpcEndpoint)
  const fees = await feeOverrides(signer.provider as providers.JsonRpcProvider)
  const transaction = await signer.sendTransaction({ to, value, ...fees })
  const receipt = await transaction.wait(1)

  return { transaction, receipt }
}

export async function sendBzzTransaction(privateKey: string, to: string, value: string, blockchainRpcEndpoint: string) {
  const signer = await makeReadySigner(privateKey, blockchainRpcEndpoint)
  const fees = await feeOverrides(signer.provider as providers.JsonRpcProvider)
  const bzz = new Contract('0xdBF3Ea6F5beE45c02255B2c26a16F300502F68da', bzzContractInterface, signer)
  const transaction = await bzz.transfer(to, value, { ...fees })
  const receipt = await transaction.wait(1)

  return { transaction, receipt }
}

/**
 * Gas limit Nook sends with every batch purchase (R4-6). Bee's own estimate
 * (+ buffer) can fall short: createBatch may have to expire a backlog of old
 * batches first, and that backlog can grow between Bee's estimate and the
 * block the transaction lands in — observed live: 534,120 limit, out of gas;
 * the cleanup alone (expireLimited(25)) then used 511k. Bee 2.8.2 honours the
 * `Gas-Limit` header on POST /stamps (limit = max(header, configured)). Only
 * gas actually used is paid; the limit just needs xDAI cover up front
 * (~0.002–0.008 xDAI at typical Gnosis gas prices).
 */
export const BATCH_CREATE_GAS_LIMIT = '1500000'

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
      const fees = await feeOverrides(signer.provider as providers.JsonRpcProvider)
      const transaction = await signer.sendTransaction({ to: NOTIFY_REGISTRY_ADDRESS, data, ...fees })
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
  const fees = await feeOverrides(provider)

  // Transfer all BZZ
  const bzz = new Contract('0xdBF3Ea6F5beE45c02255B2c26a16F300502F68da', bzzContractInterface, giftWallet)
  const bzzBalance = await bzz.balanceOf(giftWallet.address)

  const gasLimit = 21000
  // Most a plain transfer can cost at these fees — the sweep keeps exactly
  // this back (the unused part of the cap stays as a few-wei remainder).
  const gasCost = fees.maxFeePerGas.mul(gasLimit)

  // Check initial xDAI balance for empty-code detection
  const xdaiBalanceInitial = await provider.getBalance(giftWallet.address)

  if (bzzBalance.isZero() && xdaiBalanceInitial.lte(gasCost)) {
    throw new Error('Gift code is empty or has already been redeemed.')
  }

  if (bzzBalance.gt(0)) {
    const tx = await bzz.transfer(toAddress, bzzBalance, { ...fees })
    await tx.wait(1)
  }

  // Re-fetch xDAI balance after BZZ transfer (BZZ tx consumed some xDAI for
  // gas), with fresh fees — the base fee may have moved in between.
  const xdaiBalanceAfterBzz = await provider.getBalance(giftWallet.address)
  const sweepFees = await feeOverrides(provider)
  const xdaiToSend = xdaiBalanceAfterBzz.sub(sweepFees.maxFeePerGas.mul(gasLimit))

  if (xdaiToSend.gt(0)) {
    const tx = await giftWallet.sendTransaction({ to: toAddress, value: xdaiToSend, gasLimit, ...sweepFees })
    await tx.wait(1)
  }
}

async function makeReadySigner(privateKey: string, blockchainRpcEndpoint: string) {
  const provider = new providers.JsonRpcProvider(blockchainRpcEndpoint, 100)
  await provider.ready
  const signer = new Wallet(privateKey, provider)

  return signer
}
