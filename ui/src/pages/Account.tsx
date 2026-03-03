import Wallet from './Wallet'

export default function Account() {
  return (
    <div className="p-6 max-w-4xl">
      <h1 className="text-base font-semibold uppercase tracking-widest mb-5" style={{ color: 'rgb(var(--fg-muted))' }}>
        Account
      </h1>
      <Wallet />
    </div>
  )
}
