/**
 * WalletGate — inline prompt to connect wallet for encrypted drive operations.
 * Used in BuyDriveModal and on encrypted drive pages when wallet is not connected.
 */
import { ConnectButton } from '@rainbow-me/rainbowkit'
import { Wallet } from 'lucide-react'

interface WalletGateProps {
  message?: string
}

export default function WalletGate({ message = 'Connect your wallet to set up your encrypted drive.' }: WalletGateProps) {
  return (
    <div
      className="rounded-lg border p-4 flex flex-col items-center gap-3"
      style={{ backgroundColor: 'rgb(var(--bg))', borderColor: 'rgb(var(--border))' }}
    >
      <Wallet size={20} style={{ color: 'rgb(var(--fg-muted))' }} />
      <p className="text-xs text-center" style={{ color: 'rgb(var(--fg-muted))' }}>
        {message}
      </p>
      <ConnectButton.Custom>
        {({ openConnectModal, connectModalOpen }) => (
          <button
            onClick={openConnectModal}
            disabled={connectModalOpen}
            className="px-4 py-1.5 rounded-lg text-xs font-semibold disabled:opacity-40"
            style={{ backgroundColor: 'rgb(var(--accent))', color: '#fff' }}
          >
            Connect Wallet
          </button>
        )}
      </ConnectButton.Custom>
    </div>
  )
}
