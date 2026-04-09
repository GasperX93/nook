import { connectorsForWallets } from '@rainbow-me/rainbowkit'
import { injectedWallet, walletConnectWallet, ledgerWallet, coinbaseWallet } from '@rainbow-me/rainbowkit/wallets'
import { http, createConfig } from 'wagmi'
import { mainnet } from 'wagmi/chains'

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
  chains: [mainnet],
  connectors,
  transports: {
    [mainnet.id]: http('https://ethereum-rpc.publicnode.com', {
      timeout: 30_000,
      retryCount: 3,
      retryDelay: 1_000,
    }),
  },
})
