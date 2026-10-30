import { describe, expect, it, vi } from 'vitest'
import {
  type Address,
  ContractFunctionExecutionError,
  ContractFunctionRevertedError,
  decodeFunctionData,
  encodeFunctionData,
  encodeFunctionResult,
  type Hex,
  namehash,
  zeroAddress,
} from 'viem'

import {
  checkCanLink,
  checkEthName,
  COMPOSITE_RESOLVER_INTERFACE,
  confirmLinked,
  dnsEncode,
  findWritableResolver,
  LEGACY_CONTENTHASH_INTERFACE,
  LEGACY_SET_CONTENTHASH_ABI,
  readContenthash,
  setContenthashCall,
  V2_CONTENTHASH_SETTER_INTERFACE,
  V2_SET_CONTENTHASH_ABI,
} from './ens-link'

// Real mainnet addresses (verified 2026-10-30), used as labels here.
const MIRROR = '0x394D8EB4a4fDF599384DeAb25F31d111d755c398' as Address
const V2_MIRROR = '0x3071AD643cE4Ed8b3D67b289845b45dB82b068A4' as Address
const PUBLIC_RESOLVER = '0x231b0Ee14048e9dCcD1d247744d114a4EB5E8E63' as Address
const PERMISSIONED = '0xF4f1007EA430848F2fAd60e405A54Fc100fEc341' as Address
const OWNER = '0x00284d2e4b7201f070f7d02bf6c899be33b0aa56' as Address
const HASH = `0xe40101fa011b20${'ab'.repeat(32)}` as Hex

function revertError(): ContractFunctionExecutionError {
  return new ContractFunctionExecutionError(
    new ContractFunctionRevertedError({ abi: [], functionName: 'setContenthash' }),
    { abi: [], functionName: 'setContenthash' },
  )
}

/** A fake chain: which interfaces each resolver reports, and where each composite points. */
function fakeEns(opts: {
  start: Address
  interfaces: Record<string, string[]>
  next?: Record<string, Address | 'revert'>
}) {
  return {
    getEnsResolver: vi.fn(async () => opts.start),
    readContract: vi.fn(
      async ({ address, functionName, args }: { address: Address; functionName: string; args: unknown[] }) => {
        if (functionName === 'supportsInterface') return (opts.interfaces[address] ?? []).includes(args[0] as string)

        if (functionName === 'getResolver') {
          const next = opts.next?.[address]

          if (next === 'revert' || next === undefined) throw revertError()

          return [next, false]
        }
        throw new Error(`unexpected ${functionName}`)
      },
    ),
  }
}

describe('checkEthName', () => {
  it('normalizes and accepts .eth names and subnames', () => {
    expect(checkEthName('  Gasper.ETH ')).toEqual({ ok: true, name: 'gasper.eth' })
    expect(checkEthName('blog.gasper.eth')).toEqual({ ok: true, name: 'blog.gasper.eth' })
  })

  it('refuses DNS names, bare labels and empty input (.eth only for Devcon)', () => {
    expect(checkEthName('nook.com')).toEqual({ ok: false, reason: 'not-eth' })
    expect(checkEthName('eth')).toEqual({ ok: false, reason: 'not-eth' })
    expect(checkEthName('gasper..eth')).toEqual({ ok: false, reason: 'invalid' })
    expect(checkEthName('   ')).toEqual({ ok: false, reason: 'empty' })
  })

  it("doesn't throw on names normalize() rejects", () => {
    expect(checkEthName('a b.eth')).toEqual({ ok: false, reason: 'invalid' })
  })
})

describe('findWritableResolver', () => {
  it('unmigrated v1 name: looks through the mirror to the PublicResolver (namehash setter)', async () => {
    const client = fakeEns({
      start: MIRROR,
      interfaces: { [MIRROR]: [COMPOSITE_RESOLVER_INTERFACE], [PUBLIC_RESOLVER]: [LEGACY_CONTENTHASH_INTERFACE] },
      next: { [MIRROR]: PUBLIC_RESOLVER },
    })

    expect(await findWritableResolver(client as never, 'nook-drive.eth')).toEqual({
      kind: 'ok',
      resolver: PUBLIC_RESOLVER,
      setter: 'namehash',
    })
  })

  it('v2 name: PermissionedResolver directly (DNS-name setter)', async () => {
    const client = fakeEns({ start: PERMISSIONED, interfaces: { [PERMISSIONED]: [V2_CONTENTHASH_SETTER_INTERFACE] } })

    expect(await findWritableResolver(client as never, 'nick.eth')).toEqual({
      kind: 'ok',
      resolver: PERMISSIONED,
      setter: 'dnsname',
    })
  })

  it('no resolver: viem returns the zero address, not null', async () => {
    const client = fakeEns({ start: zeroAddress, interfaces: {} })

    expect(await findWritableResolver(client as never, 'typo.eth')).toEqual({ kind: 'no-resolver' })
  })

  it('mirror chain that ends at zero (v1 → v2 mirror → none) is "no resolver", not "unsupported"', async () => {
    const client = fakeEns({
      start: MIRROR,
      interfaces: { [MIRROR]: [COMPOSITE_RESOLVER_INTERFACE], [V2_MIRROR]: [COMPOSITE_RESOLVER_INTERFACE] },
      next: { [MIRROR]: V2_MIRROR, [V2_MIRROR]: zeroAddress },
    })

    expect(await findWritableResolver(client as never, 'taoli.eth')).toEqual({ kind: 'no-resolver' })
  })

  it('mirrors pointing at each other stop after a few hops', async () => {
    const client = fakeEns({
      start: MIRROR,
      interfaces: { [MIRROR]: [COMPOSITE_RESOLVER_INTERFACE], [V2_MIRROR]: [COMPOSITE_RESOLVER_INTERFACE] },
      next: { [MIRROR]: V2_MIRROR, [V2_MIRROR]: MIRROR },
    })

    expect((await findWritableResolver(client as never, 'loop.eth')).kind).toBe('unsupported')
    expect(client.readContract.mock.calls.filter(c => c[0].functionName === 'getResolver').length).toBe(4)
  })

  it('a composite whose getResolver reverts is unsupported', async () => {
    const client = fakeEns({
      start: MIRROR,
      interfaces: { [MIRROR]: [COMPOSITE_RESOLVER_INTERFACE] },
      next: { [MIRROR]: 'revert' },
    })

    expect(await findWritableResolver(client as never, 'odd.eth')).toEqual({ kind: 'unsupported', resolver: MIRROR })
  })

  it('a resolver with neither contenthash interface is unsupported (e.g. offchain)', async () => {
    const client = fakeEns({ start: PERMISSIONED, interfaces: {} })

    expect((await findWritableResolver(client as never, 'offchain.eth')).kind).toBe('unsupported')
  })

  it('an unreachable RPC is "failed"', async () => {
    const client = {
      getEnsResolver: vi.fn(async () => Promise.reject(new Error('fetch failed'))),
      readContract: vi.fn(),
    }

    expect((await findWritableResolver(client as never, 'gasper.eth')).kind).toBe('failed')
  })
})

describe('setContenthashCall', () => {
  // The review found that one ABI with both overloads encodes the namehash
  // call with the v2 selector — every v1 write would fail.
  it('v1 call encodes with the namehash selector 0x304e6ade', () => {
    const call = setContenthashCall(PUBLIC_RESOLVER, 'namehash', 'gasper.eth', HASH)
    const data = encodeFunctionData({ abi: call.abi, functionName: 'setContenthash', args: call.args } as never)

    expect(data.slice(0, 10)).toBe('0x304e6ade')
    expect(call.abi).toBe(LEGACY_SET_CONTENTHASH_ABI)
    expect(call.args[0]).toBe(namehash('gasper.eth'))
  })

  it('v2 call encodes with the DNS-name selector 0xc5d7badd', () => {
    const call = setContenthashCall(PERMISSIONED, 'dnsname', 'nick.eth', HASH)
    const data = encodeFunctionData({ abi: call.abi, functionName: 'setContenthash', args: call.args } as never)

    expect(data.slice(0, 10)).toBe('0xc5d7badd')
    expect(call.abi).toBe(V2_SET_CONTENTHASH_ABI)
    expect(call.args[0]).toBe(dnsEncode('nick.eth'))
  })
})

const CONTENTHASH_ABI = [
  {
    name: 'contenthash',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'node', type: 'bytes32' }],
    outputs: [{ type: 'bytes' }],
  },
] as const

function universalResolver(hash: Hex | 'revert' | 'down') {
  return {
    readContract: vi.fn(async ({ args, blockNumber }: { args: [Hex, Hex]; blockNumber?: bigint }) => {
      if (hash === 'down') throw new Error('fetch failed')

      if (hash === 'revert') throw revertError()
      decodeFunctionData({ abi: CONTENTHASH_ABI, data: args[1] })

      return [
        encodeFunctionResult({ abi: CONTENTHASH_ABI, functionName: 'contenthash', result: hash }),
        PUBLIC_RESOLVER,
        blockNumber,
      ]
    }),
  }
}

describe('readContenthash', () => {
  it('returns the hash, null when none is set, and null when the Universal Resolver reverts', async () => {
    expect(await readContenthash(universalResolver(HASH) as never, 'gasper.eth')).toBe(HASH)
    expect(await readContenthash(universalResolver('0x') as never, 'gasper.eth')).toBeNull()
    expect(await readContenthash(universalResolver('revert') as never, 'gasper.eth')).toBeNull()
  })

  it('throws when Ethereum is unreachable', async () => {
    await expect(readContenthash(universalResolver('down') as never, 'gasper.eth')).rejects.toThrow()
  })

  it('reads at the given block', async () => {
    const client = universalResolver(HASH)

    await readContenthash(client as never, 'gasper.eth', 123n)
    expect(client.readContract.mock.calls[0][0].blockNumber).toBe(123n)
  })
})

describe('confirmLinked', () => {
  it('true once the name returns the new hash', async () => {
    expect(await confirmLinked(universalResolver(HASH) as never, 'gasper.eth', HASH, 1n, { delayMs: 0 })).toBe(true)
  })

  it('false after the retries when it never does', async () => {
    const client = universalResolver('0x')

    expect(await confirmLinked(client as never, 'gasper.eth', HASH, 1n, { attempts: 3, delayMs: 0 })).toBe(false)
    expect(client.readContract).toHaveBeenCalledTimes(3)
  })
})

describe('checkCanLink', () => {
  const call = setContenthashCall(PUBLIC_RESOLVER, 'namehash', 'gasper.eth', HASH)
  const chain = (over: Partial<Record<string, unknown>>) => ({
    simulateContract: vi.fn(async () => ({})),
    estimateContractGas: vi.fn(async () => 50_000n),
    estimateFeesPerGas: vi.fn(async () => ({ maxFeePerGas: 10_000_000_000n })),
    getBalance: vi.fn(async () => 10n ** 18n),
    ...over,
  })

  it('ok when the simulation passes and the balance covers the fee', async () => {
    expect(await checkCanLink(chain({}) as never, call, OWNER)).toEqual({ ok: true })
  })

  it('a revert means this wallet may not change the name', async () => {
    const client = chain({ simulateContract: vi.fn(async () => Promise.reject(revertError())) })

    expect(await checkCanLink(client as never, call, OWNER)).toEqual({ ok: false, reason: 'not-allowed' })
  })

  it('an RPC failure is not reported as "not allowed"', async () => {
    const client = chain({ simulateContract: vi.fn(async () => Promise.reject(new Error('fetch failed'))) })

    expect((await checkCanLink(client as never, call, OWNER)).ok).toBe(false)
    expect(((await checkCanLink(client as never, call, OWNER)) as { reason: string }).reason).toBe('failed')
  })

  it('too little ETH for the fee', async () => {
    const client = chain({ getBalance: vi.fn(async () => 1n) })

    expect(await checkCanLink(client as never, call, OWNER)).toEqual({
      ok: false,
      reason: 'no-funds',
      fee: 50_000n * 10_000_000_000n,
    })
  })

  it("can't estimate the fee: leaves it to the wallet", async () => {
    const client = chain({ estimateFeesPerGas: vi.fn(async () => Promise.reject(new Error('no'))) })

    expect(await checkCanLink(client as never, call, OWNER)).toEqual({ ok: true })
  })
})
