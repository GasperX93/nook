import { connectorsForWallets } from '@rainbow-me/rainbowkit'
import { injectedWallet, walletConnectWallet, ledgerWallet, coinbaseWallet } from '@rainbow-me/rainbowkit/wallets'
import { fallback, http, createConfig } from 'wagmi'
import { gnosis, mainnet } from 'wagmi/chains'

import { GNOSIS_RPC_FALLBACK_URL, GNOSIS_RPC_URL } from './notify/constants'

const projectId = import.meta.env.VITE_WALLETCONNECT_PROJECT_ID || '6a772084d73e9d71ff25f10aa5e8e28f'

const connectors = connectorsForWallets(
  [
    {
      groupName: 'Supported',
      wallets: [injectedWallet, walletConnectWallet, ledgerWallet, coinbaseWallet],
    },
  ],
  { appName: 'Nook', projectId },
)

export const wagmiConfig = createConfig({
  chains: [gnosis, mainnet],
  connectors,
  transports: {
    [mainnet.id]: http('https://ethereum-rpc.publicnode.com', {
      timeout: 30_000,
      retryCount: 3,
      retryDelay: 1_000,
    }),
    // Falls over to an independent public RPC when the first throttles.
    [gnosis.id]: fallback([
      http(GNOSIS_RPC_URL, { timeout: 30_000, retryCount: 1, retryDelay: 1_000 }),
      http(GNOSIS_RPC_FALLBACK_URL, { timeout: 30_000, retryCount: 2, retryDelay: 1_000 }),
    ]),
  },
})
