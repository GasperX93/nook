import type { NotifyProvider } from '@swarm-notify/sdk'
import type { WalletClient } from 'viem'

import { GNOSIS_RPC_URL } from './constants'

async function rpcCall<T>(method: string, params: unknown[]): Promise<T> {
  const res = await fetch(GNOSIS_RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  const json = (await res.json()) as { result?: T; error?: { message: string } }

  if (json.error) throw new Error(`Gnosis RPC ${method} failed: ${json.error.message}`)

  return json.result as T
}

const toHex = (n: number) => `0x${n.toString(16)}`

export function createNotifyProvider(walletClient?: WalletClient): NotifyProvider {
  return {
    async getLogs(filter) {
      const logs = await rpcCall<Array<{ data: string; blockNumber: string }>>('eth_getLogs', [
        {
          address: filter.address,
          topics: filter.topics,
          fromBlock: toHex(filter.fromBlock),
          toBlock: !filter.toBlock || filter.toBlock === 'latest' ? 'latest' : toHex(filter.toBlock),
        },
      ])

      return logs.map(l => ({ data: l.data, blockNumber: parseInt(l.blockNumber, 16) }))
    },
    async call(tx) {
      return await rpcCall<string>('eth_call', [{ to: tx.to, data: tx.data }, 'latest'])
    },
    async sendTransaction(tx) {
      if (!walletClient) {
        throw new Error('Wallet not connected — connect a wallet to send notifications')
      }

      return walletClient.sendTransaction({
        to: tx.to as `0x${string}`,
        data: tx.data as `0x${string}`,
        value: tx.value ? BigInt(tx.value) : undefined,
        account: walletClient.account!,
        chain: walletClient.chain ?? null,
      })
    },
  }
}
