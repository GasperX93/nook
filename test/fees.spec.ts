import { BigNumber, utils } from 'ethers'

import { feesFrom, friendlyChainError, MIN_PRIORITY_FEE } from '../src/blockchain'

describe('transaction fees (F-2)', () => {
  it('pays at least the minimum tip even when the node suggests ~1 wei', () => {
    const fees = feesFrom(BigNumber.from(20), BigNumber.from(1))

    expect(fees.maxPriorityFeePerGas.eq(MIN_PRIORITY_FEE)).toBe(true)
    expect(fees.type).toBe(2)
  })

  it('leaves the tip intact when the base fee rises before inclusion', () => {
    // The failure seen live: cap = gasPrice = base + 1 → a +1 base fee left a 0 tip.
    const base = BigNumber.from(20)
    const fees = feesFrom(base, null)
    const laterBase = base.mul(2) // base fee may double and the tip still holds
    const effectiveTip = fees.maxFeePerGas.sub(laterBase)

    expect(effectiveTip.gte(fees.maxPriorityFeePerGas)).toBe(true)
  })

  it('keeps a higher suggested tip', () => {
    const tip = utils.parseUnits('3', 'gwei')

    expect(feesFrom(BigNumber.from(20), tip).maxPriorityFeePerGas.eq(tip)).toBe(true)
  })

  it('turns the raw FeeTooLow RPC error into a readable message', () => {
    const raw =
      'processing response error (body="{\\"jsonrpc\\":\\"2.0\\",\\"error\\":{\\"code\\":-32000,\\"message\\":\\"FeeTooLow, EffectivePriorityFeePerGas too low 0 < 1, BaseFee: 18\\"}}")'

    expect(friendlyChainError(raw)).toBe('The network fee changed while sending — please try again.')
    expect(friendlyChainError('replacement transaction underpriced')).toBeNull()
  })
})
