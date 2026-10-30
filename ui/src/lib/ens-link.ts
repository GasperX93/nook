/**
 * Linking an ENS name to a Swarm hash (contenthash), ENSv1 and ENSv2.
 *
 * ENSv2 went live on mainnet on 2026-10-27. Since then the Universal Resolver
 * (behind viem's getEnsResolver) returns a read-only mirror for names that
 * weren't moved to v2, and moved or new names use a per-account
 * PermissionedResolver whose setter takes a DNS-encoded name instead of a
 * namehash. The rule here follows ENS's own (docs: Resolvers → Interacting;
 * ensjs getResolver), verified on mainnet 2026-10-30 and reviewed — see
 * spindle notes/ensv2-link-domain-2026-10-30.md:
 *
 * 1. find the name's resolver, looking through composite (mirror) resolvers
 * 2. pick the setter by ERC-165: v2 setContenthash(bytes,bytes), else legacy
 * 3. simulate the exact write from the connected wallet before asking it to sign
 * 4. after the receipt, read the link back through the Universal Resolver
 *
 * .eth names only (user decision 2026-10-30): the gateway links Nook shows
 * (eth.limo, bzz.link) don't serve DNS names.
 */
import {
  type Address,
  BaseError,
  ContractFunctionRevertedError,
  decodeFunctionResult,
  encodeFunctionData,
  type Hex,
  namehash,
  type PublicClient,
  toHex,
  zeroAddress,
} from 'viem'
import { normalize, packetToBytes } from 'viem/ens'
import { mainnet } from 'viem/chains'

/** ICompositeResolver — e.g. the ENSv1 mirror the Universal Resolver reports for unmigrated names. */
export const COMPOSITE_RESOLVER_INTERFACE = '0xeea330f9'
/** ENSv2 IContenthashSetter: setContenthash(bytes name, bytes hash) — PermissionedResolver. */
export const V2_CONTENTHASH_SETTER_INTERFACE = '0xc5d7badd'
/** Legacy IContentHashResolver: contenthash(bytes32) + setContenthash(bytes32, bytes). */
export const LEGACY_CONTENTHASH_INTERFACE = '0xbc1c58d1'
/** Mirrors can point at each other (ENSV1Resolver ↔ ENSV2Resolver); real chains are 1–2 hops. */
const MAX_HOPS = 4

const SUPPORTS_INTERFACE_ABI = [
  {
    name: 'supportsInterface',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'interfaceId', type: 'bytes4' }],
    outputs: [{ type: 'bool' }],
  },
] as const

const COMPOSITE_GET_RESOLVER_ABI = [
  {
    name: 'getResolver',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'name', type: 'bytes' }],
    outputs: [
      { name: 'resolver', type: 'address' },
      { name: 'offchain', type: 'bool' },
    ],
  },
] as const

// The two setters MUST stay in separate ABIs: with both overloads in one ABI,
// viem encodes a namehash argument with the bytes overload's selector and
// every v1 write fails (found in review, 2026-10-30).
export const LEGACY_SET_CONTENTHASH_ABI = [
  {
    name: 'setContenthash',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'node', type: 'bytes32' },
      { name: 'hash', type: 'bytes' },
    ],
    outputs: [],
  },
] as const

export const V2_SET_CONTENTHASH_ABI = [
  {
    name: 'setContenthash',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'name', type: 'bytes' },
      { name: 'hash', type: 'bytes' },
    ],
    outputs: [],
  },
] as const

const CONTENTHASH_ABI = [
  {
    name: 'contenthash',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'node', type: 'bytes32' }],
    outputs: [{ type: 'bytes' }],
  },
] as const

const UNIVERSAL_RESOLVER_RESOLVE_ABI = [
  {
    name: 'resolve',
    type: 'function',
    stateMutability: 'view',
    inputs: [
      { name: 'name', type: 'bytes' },
      { name: 'data', type: 'bytes' },
    ],
    outputs: [{ type: 'bytes' }, { name: 'resolver', type: 'address' }],
  },
] as const

/** viem's configured Universal Resolver (ENS: never hard-code it). */
const UNIVERSAL_RESOLVER = mainnet.contracts.ensUniversalResolver.address

export type NameCheck = { ok: true; name: string } | { ok: false; reason: 'empty' | 'invalid' | 'not-eth' }

/** Normalize (ENSIP-15) and accept .eth names and their subnames only. */
export function checkEthName(input: string): NameCheck {
  const trimmed = input.trim()

  if (!trimmed) return { ok: false, reason: 'empty' }
  let name: string

  try {
    name = normalize(trimmed)
  } catch {
    return { ok: false, reason: 'invalid' }
  }
  const labels = name.split('.')

  if (labels.length < 2 || labels[labels.length - 1] !== 'eth' || labels.some(l => l === '')) {
    return { ok: false, reason: 'not-eth' }
  }

  return { ok: true, name }
}

export function dnsEncode(name: string): Hex {
  return toHex(packetToBytes(name))
}

export type Setter = 'namehash' | 'dnsname'

export type ResolverLookup =
  | { kind: 'ok'; resolver: Address; setter: Setter }
  | { kind: 'no-resolver' }
  | { kind: 'unsupported'; resolver: Address }
  | { kind: 'failed'; message: string }

type EnsReader = Pick<PublicClient, 'getEnsResolver' | 'readContract'>

async function supports(client: EnsReader, resolver: Address, interfaceId: Hex): Promise<boolean> {
  try {
    return await client.readContract({
      address: resolver,
      abi: SUPPORTS_INTERFACE_ABI,
      functionName: 'supportsInterface',
      args: [interfaceId],
    })
  } catch {
    return false
  }
}

/** Steps 1–2: the resolver that really stores the name's records, and which setter it takes. */
export async function findWritableResolver(client: EnsReader, name: string): Promise<ResolverLookup> {
  let resolver: Address

  try {
    // Fresh every time — a name's resolver can change at any moment.
    resolver = await client.getEnsResolver({ name })
  } catch (err) {
    return { kind: 'failed', message: errorMessage(err) }
  }
  const encoded = dnsEncode(name)

  for (let hop = 0; hop < MAX_HOPS; hop++) {
    // viem returns the zero address, not null, when a name has no resolver.
    if (!resolver || resolver === zeroAddress) return { kind: 'no-resolver' }

    if (!(await supports(client, resolver, COMPOSITE_RESOLVER_INTERFACE))) break
    try {
      const [next] = await client.readContract({
        address: resolver,
        abi: COMPOSITE_GET_RESOLVER_ABI,
        functionName: 'getResolver',
        args: [encoded],
      })

      resolver = next
    } catch {
      // A composite that can't name its underlying resolver can't be written.
      return { kind: 'unsupported', resolver }
    }
  }

  if (resolver === zeroAddress) return { kind: 'no-resolver' }

  if (await supports(client, resolver, COMPOSITE_RESOLVER_INTERFACE)) return { kind: 'unsupported', resolver }

  if (await supports(client, resolver, V2_CONTENTHASH_SETTER_INTERFACE)) {
    return { kind: 'ok', resolver, setter: 'dnsname' }
  }

  if (await supports(client, resolver, LEGACY_CONTENTHASH_INTERFACE)) {
    return { kind: 'ok', resolver, setter: 'namehash' }
  }

  return { kind: 'unsupported', resolver }
}

/**
 * The name's current contenthash through the Universal Resolver (works for v1,
 * v2 and mirrored names alike). `null` = none set; throws only when Ethereum
 * can't be reached.
 */
export async function readContenthash(
  client: Pick<PublicClient, 'readContract'>,
  name: string,
  blockNumber?: bigint,
): Promise<Hex | null> {
  const data = encodeFunctionData({ abi: CONTENTHASH_ABI, functionName: 'contenthash', args: [namehash(name)] })

  try {
    const [result] = await client.readContract({
      address: UNIVERSAL_RESOLVER,
      abi: UNIVERSAL_RESOLVER_RESOLVE_ABI,
      functionName: 'resolve',
      args: [dnsEncode(name), data],
      ...(blockNumber !== undefined ? { blockNumber } : {}),
    })
    const hash = decodeFunctionResult({ abi: CONTENTHASH_ABI, functionName: 'contenthash', data: result })

    return hash && hash !== '0x' ? hash : null
  } catch (err) {
    if (isRevert(err)) return null
    throw err
  }
}

export function setContenthashCall(resolver: Address, setter: Setter, name: string, contenthash: Hex) {
  return setter === 'dnsname'
    ? {
        address: resolver,
        abi: V2_SET_CONTENTHASH_ABI,
        functionName: 'setContenthash' as const,
        args: [dnsEncode(name), contenthash] as const,
      }
    : {
        address: resolver,
        abi: LEGACY_SET_CONTENTHASH_ABI,
        functionName: 'setContenthash' as const,
        args: [namehash(name), contenthash] as const,
      }
}

export type LinkCheck =
  | { ok: true }
  | { ok: false; reason: 'not-allowed' }
  | { ok: false; reason: 'no-funds'; fee: bigint }
  | { ok: false; reason: 'failed'; message: string }

type LinkChecker = Pick<PublicClient, 'simulateContract' | 'estimateContractGas' | 'estimateFeesPerGas' | 'getBalance'>

/**
 * Step 3: would this wallet's write go through? Runs on mainnet before the
 * wallet is asked to switch network or sign, so nobody pays for (or is
 * prompted about) a transaction that would revert.
 */
export async function checkCanLink(
  client: LinkChecker,
  call: ReturnType<typeof setContenthashCall>,
  account: Address,
): Promise<LinkCheck> {
  try {
    // A plain simulation checks permission only — the balance is checked below.
    await client.simulateContract({ ...call, account } as Parameters<LinkChecker['simulateContract']>[0])
  } catch (err) {
    if (isRevert(err)) return { ok: false, reason: 'not-allowed' }

    return { ok: false, reason: 'failed', message: errorMessage(err) }
  }

  try {
    const [gas, fees, balance] = await Promise.all([
      client.estimateContractGas({ ...call, account } as Parameters<LinkChecker['estimateContractGas']>[0]),
      client.estimateFeesPerGas(),
      client.getBalance({ address: account }),
    ])
    const fee = gas * (fees.maxFeePerGas ?? 0n)

    if (balance < fee) return { ok: false, reason: 'no-funds', fee }
  } catch {
    // Can't estimate the fee: let the wallet show it.
  }

  return { ok: true }
}

/** Step 4: the receipt is in — does the name now return the new hash? Retries for a lagging RPC. */
export async function confirmLinked(
  client: Pick<PublicClient, 'readContract'>,
  name: string,
  expected: Hex,
  blockNumber: bigint,
  { attempts = 4, delayMs = 3_000 } = {},
): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    try {
      const hash = await readContenthash(client, name, blockNumber)

      if (hash?.toLowerCase() === expected.toLowerCase()) return true
    } catch {
      // Ethereum unreachable — try again.
    }

    if (i < attempts - 1) await new Promise(resolve => setTimeout(resolve, delayMs))
  }

  return false
}

function isRevert(err: unknown): boolean {
  return err instanceof BaseError && err.walk(e => e instanceof ContractFunctionRevertedError) !== null
}

function errorMessage(err: unknown): string {
  if (err instanceof BaseError) return err.shortMessage

  return err instanceof Error ? err.message : String(err)
}
