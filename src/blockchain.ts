import { Contract, providers, Wallet } from 'ethers'
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
