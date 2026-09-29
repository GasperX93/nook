import { utils } from 'ethers'

import { isNotifyCalldata } from '../src/blockchain'

// The node key signs whatever /notify-ping accepts, so this guard is the whole
// boundary: only registry notify(bytes32,bytes) calldata may pass.
const SELECTOR = utils.id('notify(bytes32,bytes)').slice(0, 10)
const recipientHash = '11'.repeat(32)
const bytesArg = '0'.repeat(62) + '40' + '0'.repeat(62) + '03' + 'abcdef' + '0'.repeat(58)

describe('isNotifyCalldata', () => {
  it('accepts notify(bytes32,bytes) calldata', () => {
    expect(isNotifyCalldata(SELECTOR + recipientHash + bytesArg)).toBe(true)
  })

  it('uses the selector the swarm-notify SDK encodes', () => {
    // Computed with the SDK's own keccak (@noble/hashes) — not with ethers.
    expect(SELECTOR).toBe('0xe0bed146')
  })

  it('rejects any other function', () => {
    const transfer = utils.id('transfer(address,uint256)').slice(0, 10)

    expect(isNotifyCalldata(transfer + recipientHash + bytesArg)).toBe(false)
  })

  it('rejects malformed input', () => {
    expect(isNotifyCalldata(undefined)).toBe(false)
    expect(isNotifyCalldata(42)).toBe(false)
    expect(isNotifyCalldata(SELECTOR + 'zz')).toBe(false)
    expect(isNotifyCalldata(SELECTOR + 'abc')).toBe(false)
  })

  it('rejects oversized calldata', () => {
    expect(isNotifyCalldata(SELECTOR + 'ab'.repeat(5000))).toBe(false)
  })
})
