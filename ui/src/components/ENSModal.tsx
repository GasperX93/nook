import { AlertTriangle, Check, ChevronDown, ExternalLink, Globe, RefreshCw, X } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { namehash } from 'viem'
import { useAccount, usePublicClient, useSwitchChain, useWalletClient } from 'wagmi'
import { getWalletClient } from '@wagmi/core'
import { mainnet } from 'wagmi/chains'
import { wagmiConfig } from '../wagmi'

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

const RESOLVER_ABI = [
  {
    name: 'contenthash',
    inputs: [{ name: 'node', type: 'bytes32' }],
    outputs: [{ name: '', type: 'bytes' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    name: 'setContenthash',
    inputs: [
      { name: 'node', type: 'bytes32' },
      { name: 'hash', type: 'bytes' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
] as const

// ENS subgraph — same endpoint + key as Beeport (public, from ethersphere/beeport constants.ts)
const ENS_SUBGRAPH = 'https://gateway.thegraph.com/api/subgraphs/id/5XqPmWe6gjyrJtFn9cLy237i4cWw2j9HcUJEXsP5qGtH'
const ENS_SUBGRAPH_KEY = '5260e01a116d193aced5a8963059e9d7'

async function fetchOwnedDomains(address: string): Promise<string[]> {
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
    const json = await res.json()
    const names = new Set<string>()
    const addName = (n: string | undefined) => {
      if (n && !n.includes('[')) names.add(n)
    }
    for (const d of json.data?.domains ?? []) addName(d.name)
    for (const d of json.data?.wrappedDomains ?? []) addName(d.name)

    return [...names].sort()
  } catch {
    return []
  }
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
  const publicClient = usePublicClient()
  const { data: walletClient } = useWalletClient()
  const { switchChainAsync } = useSwitchChain()

  const needsChainSwitch = chainId !== mainnet.id

  const [state, setState] = useState<ModalState>('loading')
  const [domains, setDomains] = useState<string[]>([])
  const [ensName, setEnsName] = useState(currentDomain ?? '')
  const [dropdownOpen, setDropdownOpen] = useState(false)
  const [resolverAddr, setResolverAddr] = useState<`0x${string}` | null>(null)
  const [currentHash, setCurrentHash] = useState<{ protocol: string; hash: string } | null>(null)
  const [error, setError] = useState('')
  const [txHash, setTxHash] = useState('')

  const hashToSet = feedManifest ?? swarmHash
  const alreadySet = currentHash?.protocol === 'bzz' && currentHash.hash.toLowerCase() === hashToSet.toLowerCase()

  // Fetch owned domains when modal opens
  useEffect(() => {
    if (!isOpen || !isConnected || !address) return
    setState('loading')
    fetchOwnedDomains(address).then(names => {
      setDomains(names)
      setState('select')
    })
  }, [isOpen, isConnected, address])

  const selectDomain = useCallback((name: string) => {
    setEnsName(name)
    setDropdownOpen(false)
  }, [])

  const lookupDomain = useCallback(async () => {
    if (!publicClient || !ensName.trim()) return
    const name = ensName.trim().toLowerCase()

    setState('checking')
    setError('')

    try {
      const resolver = await publicClient.getEnsResolver({ name })

      if (!resolver) {
        setError('No resolver found for this domain.')
        setState('error')

        return
      }
      setResolverAddr(resolver)

      try {
        const hash = await publicClient.readContract({
          address: resolver,
          abi: RESOLVER_ABI,
          functionName: 'contenthash',
          args: [namehash(name)],
        })

        if (hash && hash !== '0x') {
          setCurrentHash(decodeContentHash(hash))
        } else {
          setCurrentHash(null)
        }
      } catch {
        setCurrentHash(null)
      }

      setState('ready')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to look up domain')
      setState('error')
    }
  }, [publicClient, ensName])

  const linkDomain = useCallback(async () => {
    if (!resolverAddr || !publicClient) return
    const name = ensName.trim().toLowerCase()

    setState('confirming')
    setError('')

    try {
      // Switch to mainnet if needed
      if (needsChainSwitch) {
        await switchChainAsync({ chainId: mainnet.id })
      }

      // Fetch fresh wallet client (hook value is stale after chain switch)
      const client = await getWalletClient(wagmiConfig, { chainId: mainnet.id })

      if (!client) {
        setError('Wallet not available. Please try again.')
        setState('error')

        return
      }

      const encoded = encodeSwarmContentHash(hashToSet)
      const tx = await client.writeContract({
        address: resolverAddr,
        abi: RESOLVER_ABI,
        functionName: 'setContenthash',
        args: [namehash(name), encoded],
      })
      setTxHash(tx)
      setState('success')
      onLinked(name)
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Transaction failed'

      if (msg.includes('User rejected') || msg.includes('denied')) {
        setState('ready')

        return
      }
      setError(msg)
      setState('error')
    }
  }, [walletClient, resolverAddr, ensName, hashToSet, publicClient, onLinked, needsChainSwitch, switchChainAsync])

  const reset = useCallback(() => {
    setState('select')
    setError('')
    setCurrentHash(null)
    setResolverAddr(null)
    setTxHash('')
    setEnsName('')
  }, [])

  if (!isOpen) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" onClick={onClose}>
      <div className="absolute inset-0 bg-black/60" />
      <div
        className="relative rounded-xl border p-6 w-full max-w-md space-y-5"
        style={{ backgroundColor: 'rgb(var(--bg-surface))', borderColor: 'rgb(var(--border))' }}
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold" style={{ color: 'rgb(var(--fg))' }}>
            Link ENS domain
          </h2>
          <button onClick={onClose} className="p-1 rounded transition-colors" style={{ color: 'rgb(var(--fg-muted))' }}>
            <X size={16} />
          </button>
        </div>

        {/* Not connected */}
        {!isConnected && (
          <div className="text-center py-6">
            <p className="text-xs" style={{ color: 'rgb(var(--fg-muted))' }}>
              Connect your wallet first using the button in the top bar.
            </p>
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
                {domains.length > 0 ? (
                  <div>
                    <label className="text-xs mb-1.5 block" style={{ color: 'rgb(var(--fg-muted))' }}>
                      Select domain
                    </label>
                    <div className="relative">
                      <button
                        onClick={() => setDropdownOpen(!dropdownOpen)}
                        disabled={state === 'checking'}
                        className="w-full flex items-center justify-between rounded-lg border px-3 py-2 text-xs font-mono focus:outline-none"
                        style={{
                          backgroundColor: 'rgb(var(--bg))',
                          color: ensName ? 'rgb(var(--fg))' : 'rgb(var(--fg-muted))',
                        }}
                      >
                        <span>{ensName || 'Choose a domain...'}</span>
                        <ChevronDown size={12} style={{ color: 'rgb(var(--fg-muted))' }} />
                      </button>
                      {dropdownOpen && (
                        <div
                          className="absolute left-0 right-0 top-full mt-1 rounded-lg border py-1 z-50 max-h-48 overflow-auto"
                          style={{ backgroundColor: 'rgb(var(--bg-surface))', borderColor: 'rgb(var(--border))' }}
                        >
                          {domains.map(name => (
                            <button
                              key={name}
                              onClick={() => selectDomain(name)}
                              className="w-full text-left px-3 py-2 text-xs font-mono transition-colors hover:bg-white/5"
                              style={{ color: name === ensName ? 'rgb(var(--accent))' : 'rgb(var(--fg))' }}
                            >
                              {name}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                ) : (
                  <div className="text-center py-4 space-y-2">
                    <p className="text-xs" style={{ color: 'rgb(var(--fg-muted))' }}>
                      No ENS domains found for this wallet.
                    </p>
                    <a
                      href="https://app.ens.domains"
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 text-xs font-medium transition-opacity hover:opacity-80"
                      style={{ color: 'rgb(var(--accent))' }}
                    >
                      Register a domain at app.ens.domains
                      <ExternalLink size={10} />
                    </a>
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

                <button
                  onClick={lookupDomain}
                  disabled={state === 'checking' || !ensName.trim()}
                  className="w-full px-4 py-2 rounded-lg text-xs font-semibold transition-colors disabled:opacity-40"
                  style={{ backgroundColor: 'rgb(var(--accent))', color: '#fff' }}
                >
                  {state === 'checking' ? 'Checking...' : 'Continue'}
                </button>

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
                    {ensName}
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
                      This content hash is already set on {ensName}.
                    </p>
                  </div>
                ) : needsChainSwitch ? (
                  <p className="text-[10px]" style={{ color: 'rgb(var(--fg-muted))' }}>
                    Your wallet is on a different network. Clicking "Link domain" will prompt you to switch to Ethereum
                    mainnet.
                  </p>
                ) : null}

                <div className="flex gap-2">
                  <button
                    onClick={reset}
                    className="px-3 py-2 rounded-lg text-xs font-semibold transition-colors"
                    style={{ color: 'rgb(var(--fg-muted))' }}
                  >
                    Back
                  </button>
                  {!alreadySet && (
                    <button
                      onClick={linkDomain}
                      className="flex-1 px-4 py-2 rounded-lg text-xs font-semibold transition-colors"
                      style={{ backgroundColor: 'rgb(var(--accent))', color: '#fff' }}
                    >
                      {needsChainSwitch ? 'Switch network & link' : 'Link domain'}
                    </button>
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
                  href={`https://${ensName}.limo`}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1.5 text-xs font-medium transition-colors hover:underline"
                  style={{ color: 'rgb(var(--accent))' }}
                >
                  <Globe size={12} />
                  {ensName}.limo
                  <ExternalLink size={10} />
                </a>
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
                <button
                  onClick={onClose}
                  className="px-4 py-2 rounded-lg text-xs font-semibold transition-colors"
                  style={{ backgroundColor: 'rgb(var(--accent))', color: '#fff' }}
                >
                  Done
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
