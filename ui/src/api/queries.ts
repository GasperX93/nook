import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { beeApi, type ChainState } from './bee'
import { api } from './client'
import { serverApi } from './server'

export const queryKeys = {
  info: ['info'] as const,
  status: ['status'] as const,
  peers: ['peers'] as const,
  config: ['config'] as const,
  nookLogs: ['logs', 'desktop'] as const,
  beeLogs: ['logs', 'bee'] as const,
}

export function useInfo() {
  return useQuery({ queryKey: queryKeys.info, queryFn: api.getInfo })
}

export function useStatus() {
  return useQuery({
    queryKey: queryKeys.status,
    queryFn: api.getStatus,
    refetchInterval: 5_000,
  })
}

export function usePeers() {
  return useQuery({
    queryKey: queryKeys.peers,
    queryFn: api.getPeers,
    refetchInterval: query => (query.state.status === 'error' ? 30_000 : 10_000),
    retry: false,
  })
}

export function useConfig() {
  return useQuery({ queryKey: queryKeys.config, queryFn: api.getConfig })
}

export function useNookLogs() {
  return useQuery({
    queryKey: queryKeys.nookLogs,
    queryFn: api.getNookLogs,
    refetchInterval: 10_000,
  })
}

export function useBeeLogs() {
  return useQuery({
    queryKey: queryKeys.beeLogs,
    queryFn: api.getBeeLogs,
    refetchInterval: 10_000,
  })
}

export function useRestart() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: api.restart,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.status })
    },
  })
}

export function useUpdateConfig() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: api.updateConfig,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.config })
    },
  })
}

// ─── Bee node queries ─────────────────────────────────────────────────────────

export function useBeeHealth() {
  return useQuery({
    queryKey: ['bee', 'health'],
    queryFn: beeApi.health,
    retry: false,
    refetchInterval: 10_000,
  })
}

export function useTopology() {
  return useQuery({
    queryKey: ['bee', 'topology'],
    queryFn: beeApi.getTopology,
    refetchInterval: 15_000,
  })
}

export function useWallet() {
  return useQuery({
    queryKey: ['bee', 'wallet'],
    queryFn: beeApi.getWallet,
    refetchInterval: query => (query.state.status === 'error' ? 30_000 : 15_000),
    retry: false,
  })
}

export function useAddresses() {
  return useQuery({
    queryKey: ['bee', 'addresses'],
    queryFn: beeApi.getAddresses,
    staleTime: Infinity,
  })
}

export function useStamps() {
  return useQuery({
    queryKey: ['bee', 'stamps'],
    queryFn: beeApi.getStamps,
    refetchInterval: query => (query.state.status === 'error' ? 60_000 : 30_000),
    retry: false,
    select: data => data.stamps,
  })
}

export function useChequebookBalance() {
  return useQuery({
    queryKey: ['bee', 'chequebook'],
    queryFn: beeApi.getChequebookBalance,
    refetchInterval: query => (query.state.status === 'error' ? 60_000 : 30_000),
    retry: false,
  })
}

// Last good /chainstate, kept across restarts (R5-14). Right after a Bee
// restart — while it re-syncs and the public RPC throttles — /chainstate can
// fail for minutes ("get minimum validity blocks failed"), leaving a freshly
// opened page with no price at all and Publish / New drive disabled. The
// storage price moves slowly, so a recent value is a fine estimate; the
// purchase itself still goes through Bee at the live price.
const CHAINSTATE_CACHE_KEY = 'nook.chainstate.v1'
const CHAINSTATE_CACHE_MAX_AGE_MS = 6 * 60 * 60_000

function readCachedChainState(): { chainState: ChainState; at: number } | undefined {
  try {
    const cached = JSON.parse(localStorage.getItem(CHAINSTATE_CACHE_KEY) ?? 'null')

    if (cached?.chainState?.currentPrice && Date.now() - cached.at < CHAINSTATE_CACHE_MAX_AGE_MS) return cached
  } catch {
    // unreadable cache — ignore
  }

  return undefined
}

export function useChainState() {
  return useQuery({
    queryKey: ['bee', 'chainstate'],
    queryFn: async () => {
      const chainState = await beeApi.getChainState()

      try {
        localStorage.setItem(CHAINSTATE_CACHE_KEY, JSON.stringify({ chainState, at: Date.now() }))
      } catch {
        // storage unavailable — the live value still works
      }

      return chainState
    },
    initialData: () => readCachedChainState()?.chainState,
    initialDataUpdatedAt: () => readCachedChainState()?.at,
    // Recover quickly while Bee can't answer; relax once it does.
    refetchInterval: query => (query.state.status === 'error' ? 10_000 : 60_000),
    retry: false,
  })
}

export function useReclaimableDrives() {
  return useQuery({
    queryKey: ['server', 'reclaimable'],
    queryFn: serverApi.listReclaimable,
    refetchInterval: query => (query.state.status === 'error' ? 60_000 : 30_000),
    retry: false,
    select: data => data.drives,
  })
}

export function useCreateReclaimable() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async ({
      amount,
      depth,
      encrypted,
      label,
    }: {
      amount: string
      depth: number
      encrypted: boolean
      label?: string
    }) => serverApi.createReclaimable(amount, depth, encrypted, label),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['server', 'reclaimable'] })
      // The batch also shows up on the node's stamp list (filtered out of the
      // classic drive cards, but the wallet balance moved)
      queryClient.invalidateQueries({ queryKey: ['bee', 'stamps'] })
      queryClient.invalidateQueries({ queryKey: ['bee', 'wallet'] })
    },
  })
}

export function useBuyStamp() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async ({
      amount,
      depth,
      immutable,
      label,
    }: {
      amount: string
      depth: number
      immutable?: boolean
      label?: string
    }) => serverApi.buyStamp(amount, depth, Boolean(immutable), label),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['bee', 'stamps'] })
    },
  })
}

export function useTopupStamp() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async ({ id, amount }: { id: string; amount: string }) => beeApi.topupStamp(id, amount),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['bee', 'stamps'] })
    },
  })
}
