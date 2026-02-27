import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { beeApi } from './bee'
import { api } from './client'

export const queryKeys = {
  info: ['info'] as const,
  status: ['status'] as const,
  peers: ['peers'] as const,
  config: ['config'] as const,
  desktopLogs: ['logs', 'desktop'] as const,
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
    refetchInterval: 10_000,
  })
}

export function useConfig() {
  return useQuery({ queryKey: queryKeys.config, queryFn: api.getConfig })
}

export function useDesktopLogs() {
  return useQuery({
    queryKey: queryKeys.desktopLogs,
    queryFn: api.getDesktopLogs,
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

export function useWallet() {
  return useQuery({
    queryKey: ['bee', 'wallet'],
    queryFn: beeApi.getWallet,
    refetchInterval: 15_000,
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
    refetchInterval: 30_000,
    select: (data) => data.stamps,
  })
}

export function useChainState() {
  return useQuery({
    queryKey: ['bee', 'chainstate'],
    queryFn: beeApi.getChainState,
    refetchInterval: 60_000,
  })
}

export function useBuyStamp() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ amount, depth, immutable }: { amount: string; depth: number; immutable?: boolean }) =>
      beeApi.buyStamp(amount, depth, immutable),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['bee', 'stamps'] })
    },
  })
}

export function useTopupStamp() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, amount }: { id: string; amount: string }) =>
      beeApi.topupStamp(id, amount),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['bee', 'stamps'] })
    },
  })
}
