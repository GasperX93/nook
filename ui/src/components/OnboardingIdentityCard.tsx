import { ConnectButton } from '@rainbow-me/rainbowkit'
import { Check, UserCircle2, X } from 'lucide-react'
import { useState } from 'react'

import { useDerivedKey } from '../hooks/useDerivedKey'
import { getPublishConsent, setPublishConsent } from '../lib/publish-consent'

/**
 * "Meanwhile — set up your identity" (#130/#131): a parallel card shown during
 * onboarding's waiting states (funding, syncing, ready). Identity setup uses
 * the dead time instead of adding a blocking step — the wallet wall never
 * gates the funnel, and gift-code users aren't forced through MetaMask.
 *
 * Consent ("make me findable") is collected here, pre-ticked; the actual
 * publish happens automatically once the reserved space exists
 * (useAutoPublish) — the setup≠publish split.
 */
export default function OnboardingIdentityCard() {
  const { signer, derive, deriving, error, walletConnected } = useDerivedKey()
  const [dismissed, setDismissed] = useState(false)
  const [consent, setConsent] = useState(getPublishConsent)

  if (dismissed) return null

  function toggleConsent() {
    setConsent(prev => {
      setPublishConsent(!prev)

      return !prev
    })
  }

  return (
    <div
      className="rounded-lg border px-4 py-3 text-left space-y-2"
      style={{ backgroundColor: 'rgb(var(--bg-surface))', borderColor: 'rgb(var(--border))' }}
    >
      <div className="flex items-start gap-2">
        <UserCircle2 size={15} className="shrink-0 mt-0.5" style={{ color: 'rgb(var(--fg-muted))' }} />
        <div className="flex-1 space-y-2">
          {signer ? (
            <>
              <p className="text-xs font-semibold flex items-center gap-1.5">
                <Check size={12} style={{ color: 'rgb(74,222,128)' }} /> Identity created
              </p>
              <p className="text-[11px] leading-relaxed" style={{ color: 'rgb(var(--fg-muted))' }}>
                {consent
                  ? 'You will be made findable automatically as soon as your reserved space is ready.'
                  : 'You can publish yourself later from Account → Identity.'}
              </p>
              <label className="flex items-center gap-2 text-[11px] cursor-pointer" style={{ color: 'rgb(var(--fg))' }}>
                <input type="checkbox" checked={consent} onChange={toggleConsent} />
                Make me findable by my Nook address
              </label>
            </>
          ) : (
            <>
              <p className="text-xs font-semibold">Meanwhile — set up your identity</p>
              <p className="text-[11px] leading-relaxed" style={{ color: 'rgb(var(--fg-muted))' }}>
                Needed for messaging and sharing. Free — no transaction, nothing leaves your device.
              </p>
              {!walletConnected ? (
                <ConnectButton.Custom>
                  {({ openConnectModal, connectModalOpen }) => (
                    <button
                      onClick={openConnectModal}
                      disabled={connectModalOpen}
                      className="text-xs font-semibold px-3 py-1.5 rounded-lg"
                      style={{ backgroundColor: 'rgb(var(--accent))', color: 'rgb(var(--primary-foreground))' }}
                    >
                      Connect wallet &amp; create
                    </button>
                  )}
                </ConnectButton.Custom>
              ) : (
                <button
                  onClick={async () => derive()}
                  disabled={deriving}
                  className="text-xs font-semibold px-3 py-1.5 rounded-lg"
                  style={{ backgroundColor: 'rgb(var(--accent))', color: 'rgb(var(--primary-foreground))' }}
                >
                  {deriving ? 'Check your wallet — approve the signatures…' : 'Create identity'}
                </button>
              )}
              {error && (
                <p className="text-[11px]" style={{ color: 'rgb(248,113,113)' }}>
                  {error}
                </p>
              )}
            </>
          )}
        </div>
        <button onClick={() => setDismissed(true)} aria-label="Dismiss" className="p-1 -m-1 hover:opacity-60">
          <X size={12} style={{ color: 'rgb(var(--fg-muted))' }} />
        </button>
      </div>
    </div>
  )
}
