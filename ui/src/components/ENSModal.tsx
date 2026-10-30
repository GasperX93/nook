import { useConnectModal } from '@rainbow-me/rainbowkit'
import { AlertTriangle, Check, ExternalLink, Globe, RefreshCw, X } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { type Address, formatEther } from 'viem'
import { useAccount, usePublicClient, useSwitchChain } from 'wagmi'
import { getWalletClient } from '@wagmi/core'
import { mainnet } from 'wagmi/chains'
import { bzzLink } from '../lib/ens-gateway'
import {
  checkCanLink,
  checkEthName,
  confirmLinked,
  findWritableResolver,
  type LinkCheck,
  readContenthash,
  type ResolverLookup,
  setContenthashCall,
  type Setter,
} from '../lib/ens-link'
import { wagmiConfig } from '../wagmi'
import { Button } from './ui/button'

// EIP-1577 / ENSIP-7: Swarm content hash encoding
const SWARM_PREFIX = 'e40101fa011b20'

function encodeSwarmContentHash(swarmHash: string): `0x${string}` {
  const clean = swarmHash.startsWith('0x') ? swarmHash.slice(2) : swarmHash

  return `0x${SWARM_PREFIX}${clean}`
}

function decodeContentHash(hex: string): { protocol: string; hash: string } | null {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex

  if (!clean || clean === '') return null

  if (clean.startsWith(SWARM_PREFIX)) return { protocol: 'bzz', hash: clean.slice(SWARM_PREFIX.length) }

  if (clean.startsWith('e3010170')) return { protocol: 'ipfs', hash: clean.slice(8) }

  return { protocol: 'unknown', hash: clean }
}

// ENS subgraph — same endpoint + key as Beeport (public, from ethersphere/beeport constants.ts).
// It covers ENSv1 names only: names moved to or registered on ENSv2 may be
// missing, so the domain can also be typed (ENS docs: "let users enter a name
// manually").
const ENS_SUBGRAPH = 'https://gateway.thegraph.com/api/subgraphs/id/5XqPmWe6gjyrJtFn9cLy237i4cWw2j9HcUJEXsP5qGtH'
const ENS_SUBGRAPH_KEY = '5260e01a116d193aced5a8963059e9d7'

/** The wallet's .eth names from the subgraph; `null` when the list couldn't be loaded. */
async function fetchOwnedDomains(address: string): Promise<string[] | null> {
  const addr = address.toLowerCase()
  const query = `{
    domains(where: { owner: "${addr}" }) { name }
    wrappedDomains: domains(where: { wrappedOwner: "${addr}" }) { name }
  }`
  try {
    const res = await fetch(ENS_SUBGRAPH, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ENS_SUBGRAPH_KEY}`,
      },
      body: JSON.stringify({ query }),
    })

    if (!res.ok) return null
    const json = await res.json()

    if (!json.data) return null
    const names = new Set<string>()
    const addName = (n: string | undefined) => {
      if (!n || n.includes('[')) return
      const checked = checkEthName(n)

      if (checked.ok) names.add(checked.name)
    }
    for (const d of json.data.domains ?? []) addName(d.name)
    for (const d of json.data.wrappedDomains ?? []) addName(d.name)

    return [...names].sort()
  } catch {
    return null
  }
}

function lookupError(name: string, lookup: Exclude<ResolverLookup, { kind: 'ok' }>): string {
  if (lookup.kind === 'no-resolver') {
    return `${name} has no resolver. It may have expired, or it isn't set up yet — check it in the ENS app.`
  }

  if (lookup.kind === 'unsupported') {
    return `${name}'s resolver can't store a website link. Switch it to the standard resolver in the ENS app.`
  }

  return `Couldn't reach Ethereum to check ${name}. Try again in a moment.`
}

function linkCheckError(name: string, setter: Setter, check: Exclude<LinkCheck, { ok: true }>): string {
  if (check.reason === 'not-allowed') {
    return setter === 'dnsname'
      ? `This wallet isn't allowed to change ${name}. Connect the wallet that owns it. For a subname, give it its own resolver in the ENS app.`
      : `This wallet can't change ${name}. Connect the wallet that owns it. If it does, the name's resolver may be outdated — update it in the ENS app.`
  }

  if (check.reason === 'no-funds') {
    return `Not enough ETH on Ethereum for the fee (about ${Number(formatEther(check.fee)).toFixed(4)} ETH).`
  }

  return `Couldn't reach Ethereum to check ${name}. Try again in a moment.`
}

/** Under the name field: why the list may be empty or incomplete. */
function listHint(listFailed: boolean, count: number): string {
  if (listFailed) return "Couldn't load your domains — type the name."

  if (count === 0) return "Type the .eth name you want to link. Names on ENSv2 aren't listed here."

  return "Type it, or pick one below. Names on ENSv2 aren't listed here — type them."
}

type ModalState = 'loading' | 'select' | 'checking' | 'ready' | 'confirming' | 'pending' | 'success' | 'error'

interface ENSModalProps {
  isOpen: boolean
  onClose: () => void
  swarmHash: string
  feedManifest?: string
  currentDomain?: string
  onLinked: (domain: string) => void
}

export default function ENSModal({ isOpen, onClose, swarmHash, feedManifest, currentDomain, onLinked }: ENSModalProps) {
  const { address, isConnected, chainId } = useAccount()
  const { openConnectModal } = useConnectModal()
  // ENS lives on Ethereum mainnet — pin reads to mainnet's RPC so lookups work
  // regardless of which chain the wallet is connected to (e.g. Gnosis). The wallet
  // is only switched to mainnet at write time, in linkDomain().
  const publicClient = usePublicClient({ chainId: mainnet.id })
  const { switchChainAsync } = useSwitchChain()

  const needsChainSwitch = chainId !== mainnet.id

  const [state, setState] = useState<ModalState>('loading')
  const [domains, setDomains] = useState<string[]>([])
  const [listFailed, setListFailed] = useState(false)
  const [ensName, setEnsName] = useState(currentDomain ?? '')
  const [target, setTarget] = useState<{ name: string; resolver: Address; setter: Setter } | null>(null)
  const [currentHash, setCurrentHash] = useState<{ protocol: string; hash: string } | null>(null)
  const [error, setError] = useState('')
  const [txHash, setTxHash] = useState('')

  const hashToSet = feedManifest ?? swarmHash
  const alreadySet = currentHash?.protocol === 'bzz' && currentHash.hash.toLowerCase() === hashToSet.toLowerCase()
  // A transaction is in the wallet or on its way: closing now would lose it from view.
  const busy = state === 'confirming' || state === 'pending'
  const linkedName = target?.name ?? ensName

  // Fetch owned domains when modal opens
  useEffect(() => {
    if (!isOpen || !isConnected || !address) return
    setState('loading')
    fetchOwnedDomains(address).then(names => {
      setDomains(names ?? [])
      setListFailed(names === null)
      setState('select')
    })
  }, [isOpen, isConnected, address])

  const fail = useCallback((message: string) => {
    setError(message)
    setState('error')
  }, [])

  // Continue: everything that decides whether Link can work runs here, before
  // the wallet is asked anything.
  const lookupDomain = useCallback(async () => {
    if (!publicClient || !address) return
    const checked = checkEthName(ensName)

    if (!checked.ok) {
      if (checked.reason !== 'empty') {
        fail(
          checked.reason === 'not-eth'
            ? 'Only .eth names for now — for example yourname.eth.'
            : "That isn't a valid ENS name.",
        )
      }

      return
    }
    const name = checked.name

    setEnsName(name)
    setState('checking')
    setError('')
    setTarget(null)
    setCurrentHash(null)

    const lookup = await findWritableResolver(publicClient, name)

    if (lookup.kind !== 'ok') return fail(lookupError(name, lookup))

    let current: { protocol: string; hash: string } | null = null

    try {
      const hash = await readContenthash(publicClient, name)

      current = hash ? decodeContentHash(hash) : null
    } catch {
      return fail(`Couldn't reach Ethereum to check ${name}. Try again in a moment.`)
    }
    setCurrentHash(current)

    const isSet = current?.protocol === 'bzz' && current.hash.toLowerCase() === hashToSet.toLowerCase()

    if (!isSet) {
      const call = setContenthashCall(lookup.resolver, lookup.setter, name, encodeSwarmContentHash(hashToSet))
      const check = await checkCanLink(publicClient, call, address)

      if (!check.ok) return fail(linkCheckError(name, lookup.setter, check))
    }

    setTarget({ name, resolver: lookup.resolver, setter: lookup.setter })
    setState('ready')
  }, [publicClient, address, ensName, hashToSet, fail])

  const linkDomain = useCallback(async () => {
    if (!target || !publicClient) return
    const { name, resolver, setter } = target
    const contenthash = encodeSwarmContentHash(hashToSet)

    setState('confirming')
    setError('')

    try {
      // Switch to mainnet if needed
      if (needsChainSwitch) {
        await switchChainAsync({ chainId: mainnet.id })
      }

      // Fetch fresh wallet client (hook value is stale after chain switch)
      const client = await getWalletClient(wagmiConfig, { chainId: mainnet.id })

      if (!client) return fail('Wallet not available. Please try again.')

      // The call is one of two single-overload ABIs (see ens-link.ts); the cast
      // only joins their types — the wallet client has the account and chain.
      const call = setContenthashCall(resolver, setter, name, contenthash)
      const tx = await client.writeContract(call as unknown as Parameters<typeof client.writeContract>[0])

      setTxHash(tx)
      // Sent is not linked: wait for the transaction to be mined, and only a
      // successful receipt counts (a reverted setContenthash links nothing).
      setState('pending')
      const receipt = await publicClient.waitForTransactionReceipt({ hash: tx })

      if (receipt.status !== 'success') {
        return fail('The transaction failed on Ethereum — the domain was not linked. You can try again.')
      }

      // …and the name must now return the new hash (a write to a resolver the
      // name no longer uses would succeed and change nothing).
      if (!(await confirmLinked(publicClient, name, contenthash, receipt.blockNumber))) {
        return fail(
          `The transaction went through, but ${name} doesn't show the new link yet. Check it in the ENS app in a minute.`,
        )
      }
      setState('success')
      onLinked(name)
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Transaction failed'

      if (msg.includes('User rejected') || msg.includes('denied')) {
        setState('ready')

        return
      }
      fail(msg)
    }
  }, [target, hashToSet, publicClient, onLinked, needsChainSwitch, switchChainAsync, fail])

  const reset = useCallback(() => {
    setState('select')
    setError('')
    setCurrentHash(null)
    setTarget(null)
    setTxHash('')
    setEnsName('')
  }, [])

  if (!isOpen) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" onClick={busy ? undefined : onClose}>
      <div className="absolute inset-0 bg-black/60" />
      <div
        className="relative rounded-xl border p-6 w-full max-w-md space-y-5 max-h-[calc(100vh-2rem)] max-w-[calc(100vw-2rem)] overflow-y-auto"
        style={{ backgroundColor: 'rgb(var(--bg-surface))', borderColor: 'rgb(var(--border))' }}
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold" style={{ color: 'rgb(var(--fg))' }}>
            Link ENS domain
          </h2>
          <Button onClick={onClose} disabled={busy} variant="ghost" size="icon" className="h-8 w-8">
            <X size={16} />
          </Button>
        </div>

        {/* Not connected */}
        {/* ENS lives on Ethereum mainnet, paid with ETH — the one place Nook
            still needs an external wallet (the node wallet only holds xDAI). */}
        {!isConnected && (
          <div className="text-center py-6 space-y-3">
            <p className="text-xs" style={{ color: 'rgb(var(--fg-muted))' }}>
              Linking an ENS domain needs the Ethereum wallet that owns it.
            </p>
            <Button size="sm" onClick={openConnectModal} disabled={!openConnectModal}>
              Connect wallet
            </Button>
          </div>
        )}

        {/* Connected — main flow */}
        {isConnected && (
          <>
            {/* Loading domains */}
            {state === 'loading' && (
              <div className="text-center py-6 space-y-2">
                <RefreshCw size={16} className="animate-spin mx-auto" style={{ color: 'rgb(var(--accent))' }} />
                <p className="text-xs" style={{ color: 'rgb(var(--fg-muted))' }}>
                  Loading your ENS domains...
                </p>
              </div>
            )}

            {/* Domain selection */}
            {(state === 'select' || state === 'checking' || state === 'error') && (
              <div className="space-y-3">
                {/* Typing is the main way: the list below covers ENSv1 names only
                    (names moved to ENSv2 drop out of it), and it sits inside the
                    window, so nothing ever covers the field or Continue. */}
                <div>
                  <label htmlFor="ens-name" className="text-xs mb-1.5 block" style={{ color: 'rgb(var(--fg-muted))' }}>
                    Your domain
                  </label>
                  <input
                    id="ens-name"
                    value={ensName}
                    onChange={e => setEnsName(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === 'Enter') void lookupDomain()
                    }}
                    disabled={state === 'checking'}
                    placeholder="yourname.eth"
                    autoComplete="off"
                    spellCheck={false}
                    className="w-full rounded-lg border px-3 py-2 text-xs font-mono focus:outline-none"
                    style={{ backgroundColor: 'rgb(var(--bg))', color: 'rgb(var(--fg))' }}
                  />
                  <p className="text-[10px] mt-1" style={{ color: 'rgb(var(--fg-muted))' }}>
                    {listHint(listFailed, domains.length)}
                  </p>
                </div>

                {domains.length > 0 && (
                  <div>
                    <p className="text-[10px] uppercase tracking-widest mb-1" style={{ color: 'rgb(var(--fg-muted))' }}>
                      Found for this wallet
                    </p>
                    <div className="flex flex-wrap gap-1.5 max-h-24 overflow-auto">
                      {domains.map(name => (
                        <button
                          key={name}
                          type="button"
                          onClick={() => setEnsName(name)}
                          disabled={state === 'checking'}
                          className="rounded-md border px-2 py-1 text-[11px] font-mono transition-colors hover:bg-white/5"
                          style={{
                            borderColor: name === ensName ? 'rgb(var(--accent))' : 'rgb(var(--border))',
                            color: name === ensName ? 'rgb(var(--accent))' : 'rgb(var(--fg))',
                          }}
                        >
                          {name}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {state === 'error' && error && (
                  <div className="flex items-start gap-2 text-xs" style={{ color: '#ef4444' }}>
                    <AlertTriangle size={12} className="shrink-0 mt-0.5" />
                    <span>{error}</span>
                  </div>
                )}

                <div>
                  <p className="text-[10px] uppercase tracking-widest mb-1" style={{ color: 'rgb(var(--fg-muted))' }}>
                    {feedManifest ? 'Feed manifest' : 'Swarm hash'} to link
                  </p>
                  <p className="text-xs font-mono break-all" style={{ color: 'rgb(var(--fg-muted))' }}>
                    {hashToSet.slice(0, 16)}...{hashToSet.slice(-8)}
                  </p>
                </div>

                <Button onClick={lookupDomain} disabled={state === 'checking' || !ensName.trim()} className="w-full">
                  {state === 'checking' ? 'Checking...' : 'Continue'}
                </Button>

                <p className="text-[10px] text-center" style={{ color: 'rgb(var(--fg-muted))' }}>
                  Don't have a domain?{' '}
                  <a
                    href="https://app.ens.domains"
                    target="_blank"
                    rel="noreferrer"
                    className="underline transition-opacity hover:opacity-80"
                    style={{ color: 'rgb(var(--fg-muted))' }}
                  >
                    Register at app.ens.domains
                  </a>
                </p>
              </div>
            )}

            {/* Ready — show current hash + confirm */}
            {state === 'ready' && (
              <div className="space-y-4">
                <div className="rounded-lg border p-3 space-y-2" style={{ backgroundColor: 'rgb(var(--bg))' }}>
                  <p className="text-xs font-medium" style={{ color: 'rgb(var(--fg))' }}>
                    {linkedName}
                  </p>
                  {currentHash ? (
                    <div>
                      <p
                        className="text-[10px] uppercase tracking-widest mb-0.5"
                        style={{ color: 'rgb(var(--fg-muted))' }}
                      >
                        Current content hash ({currentHash.protocol})
                      </p>
                      <p className="text-[10px] font-mono break-all" style={{ color: 'rgb(var(--fg-muted))' }}>
                        {currentHash.hash.slice(0, 16)}...{currentHash.hash.slice(-8)}
                      </p>
                    </div>
                  ) : (
                    <p className="text-xs" style={{ color: 'rgb(var(--fg-muted))' }}>
                      No content hash set
                    </p>
                  )}
                </div>

                <div>
                  <p className="text-[10px] uppercase tracking-widest mb-1" style={{ color: 'rgb(var(--fg-muted))' }}>
                    New content hash (Swarm)
                  </p>
                  <p className="text-xs font-mono break-all" style={{ color: 'rgb(var(--fg-muted))' }}>
                    {hashToSet.slice(0, 16)}...{hashToSet.slice(-8)}
                  </p>
                  {feedManifest && (
                    <p className="text-[10px] mt-1" style={{ color: 'rgb(var(--accent))' }}>
                      Using feed manifest — future content updates will resolve automatically.
                    </p>
                  )}
                </div>

                {alreadySet ? (
                  <div
                    className="flex items-center gap-2 rounded-lg p-3"
                    style={{ backgroundColor: 'rgba(74,222,128,0.08)' }}
                  >
                    <Check size={14} style={{ color: '#4ade80' }} />
                    <p className="text-xs" style={{ color: '#4ade80' }}>
                      This content hash is already set on {linkedName}.
                    </p>
                  </div>
                ) : needsChainSwitch ? (
                  <p className="text-[10px]" style={{ color: 'rgb(var(--fg-muted))' }}>
                    Your wallet is on a different network. Clicking "Link domain" will prompt you to switch to Ethereum
                    mainnet.
                  </p>
                ) : null}

                <div className="flex gap-2">
                  <Button onClick={reset} variant="ghost">
                    Back
                  </Button>
                  {!alreadySet && (
                    <Button onClick={linkDomain} className="flex-1">
                      {needsChainSwitch ? 'Switch network & link' : 'Link domain'}
                    </Button>
                  )}
                </div>
              </div>
            )}

            {/* Confirming — waiting for wallet */}
            {state === 'confirming' && (
              <div className="text-center py-6 space-y-3">
                <RefreshCw size={20} className="animate-spin mx-auto" style={{ color: 'rgb(var(--accent))' }} />
                <p className="text-xs" style={{ color: 'rgb(var(--fg-muted))' }}>
                  Confirm in your wallet...
                </p>
              </div>
            )}

            {/* Pending — tx submitted */}
            {state === 'pending' && (
              <div className="text-center py-6 space-y-3">
                <RefreshCw size={20} className="animate-spin mx-auto" style={{ color: 'rgb(var(--accent))' }} />
                <p className="text-xs" style={{ color: 'rgb(var(--fg-muted))' }}>
                  Transaction submitted. Waiting for confirmation...
                </p>
                {txHash && (
                  <a
                    href={`https://etherscan.io/tx/${txHash}`}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 text-[10px] transition-colors hover:underline"
                    style={{ color: 'rgb(var(--fg-muted))' }}
                  >
                    <ExternalLink size={10} />
                    View on Etherscan
                  </a>
                )}
              </div>
            )}

            {/* Success */}
            {state === 'success' && (
              <div className="text-center py-6 space-y-3">
                <div
                  className="w-10 h-10 rounded-full flex items-center justify-center mx-auto"
                  style={{ backgroundColor: 'rgba(74,222,128,0.15)' }}
                >
                  <Check size={20} style={{ color: '#4ade80' }} />
                </div>
                <div>
                  <p className="text-sm font-medium mb-1" style={{ color: 'rgb(var(--fg))' }}>
                    Domain linked!
                  </p>
                  <p className="text-xs" style={{ color: 'rgb(var(--fg-muted))' }}>
                    Your website is now accessible at:
                  </p>
                </div>
                <a
                  href={`https://${linkedName}.limo`}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1.5 text-xs font-medium transition-colors hover:underline"
                  style={{ color: 'rgb(var(--accent))' }}
                >
                  <Globe size={12} />
                  {linkedName}.limo
                  <ExternalLink size={10} />
                </a>
                {bzzLink(linkedName) && (
                  <a
                    href={bzzLink(linkedName)!.url}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1.5 text-xs font-medium transition-colors hover:underline"
                    style={{ color: 'rgb(var(--accent))' }}
                  >
                    <Globe size={12} />
                    {bzzLink(linkedName)!.label}
                    <ExternalLink size={10} />
                  </a>
                )}
                {/* R5-7: gateways cache ENS lookups for a few minutes. */}
                <p className="text-[11px]" style={{ color: 'rgb(var(--fg-muted))' }}>
                  It can take a few minutes to show up. If you see an older version, refresh in a minute.
                </p>
                {txHash && (
                  <div>
                    <a
                      href={`https://etherscan.io/tx/${txHash}`}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 text-[10px] transition-colors hover:underline"
                      style={{ color: 'rgb(var(--fg-muted))' }}
                    >
                      <ExternalLink size={10} />
                      View transaction
                    </a>
                  </div>
                )}
                <Button onClick={onClose}>Done</Button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
