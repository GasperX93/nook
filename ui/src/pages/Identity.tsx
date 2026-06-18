import { Bee } from '@ethersphere/bee-js'
import { identity } from '@swarm-notify/sdk'
import { Check, Copy, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

import { useAddresses, useStamps } from '../api/queries'
import { Button } from '../components/ui/button'
import { useDerivedKey } from '../hooks/useDerivedKey'
import { bytesToHex } from '../lib/hex'
import { encodeShareLink } from '../notify/share-link'
import {
  isIdentityPublished,
  isOnboardingDismissed,
  markIdentityPublished,
  markOnboardingDismissed,
} from '../notify/storage'

const BEE_URL = `${window.location.origin}/bee-api`

export default function Identity() {
  const { signer, derive, deriving, walletConnected } = useDerivedKey()
  const { data: addresses } = useAddresses()
  const { data: stamps } = useStamps()

  const bee = useMemo(() => new Bee(BEE_URL), [])

  const [publishing, setPublishing] = useState(false)
  const [publishError, setPublishError] = useState<string | null>(null)
  const [publishedTick, setPublishedTick] = useState(0)
  const [copied, setCopied] = useState<'address' | 'share-link' | null>(null)
  const [hintDismissed, setHintDismissed] = useState(() => isOnboardingDismissed())

  const usableStamps = (stamps ?? []).filter(s => s.usable)
  const stampId = usableStamps[0]?.batchID ?? null
  const myAddress = signer?.getAddress() ?? null
  const published = myAddress ? isIdentityPublished(myAddress) : false

  useEffect(() => {
    void publishedTick
  }, [publishedTick])

  const myShareLink = useMemo(() => {
    if (!signer || !addresses) return null

    return encodeShareLink({
      ethAddress: signer.getAddress(),
      walletPublicKey: bytesToHex(signer.getPublicKey()),
      beePublicKey: addresses.publicKey,
    })
  }, [signer, addresses])

  async function handlePublish() {
    if (!signer) return setPublishError('Derive your key first')

    if (!addresses) return setPublishError('Bee node not reachable')

    if (!stampId) return setPublishError('Buy a drive first to enable publishing')

    setPublishing(true)
    setPublishError(null)
    try {
      await identity.publish(bee, signer.getSigningKey(), stampId, {
        walletPublicKey: bytesToHex(signer.getPublicKey()),
        beePublicKey: addresses.publicKey,
        ethAddress: signer.getAddress(),
      })
      const readback = await identity.resolve(bee, signer.getAddress())

      if (!readback) {
        setPublishError('Published but could not verify — try again')

        return
      }
      markIdentityPublished(signer.getAddress())
      setPublishedTick(t => t + 1)
      markOnboardingDismissed()
      setHintDismissed(true)
    } catch (e) {
      setPublishError((e as Error).message)
    } finally {
      setPublishing(false)
    }
  }

  async function handleCopy(value: string, kind: 'address' | 'share-link') {
    await navigator.clipboard.writeText(value)
    setCopied(kind)
    setTimeout(() => setCopied(null), 1500)
  }

  function handleDismissHint() {
    markOnboardingDismissed()
    setHintDismissed(true)
  }

  return (
    <div className="space-y-4">
      {!hintDismissed && !published && (
        <div
          className="rounded-xl border p-4 flex items-start gap-3"
          style={{ backgroundColor: 'rgba(247,104,8,0.06)', borderColor: 'rgba(247,104,8,0.3)' }}
        >
          <div className="flex-1 text-sm">
            <p className="font-semibold mb-1">Make yourself reachable</p>
            <p style={{ color: 'rgb(var(--fg-muted))' }}>
              Either publish your Nook address to the identity feed (others find you by typing it) or share your contact
              link manually. Either way works — pick what you prefer.
            </p>
          </div>
          <button onClick={handleDismissHint} aria-label="Dismiss" className="p-1 hover:opacity-60">
            <X size={16} />
          </button>
        </div>
      )}

      <div className="rounded-xl border p-5 space-y-4" style={{ backgroundColor: 'rgb(var(--bg-surface))' }}>
        <p className="text-xs uppercase tracking-widest" style={{ color: 'rgb(var(--fg-muted))' }}>
          How others connect with you
        </p>

        {!walletConnected && (
          <p className="text-sm" style={{ color: 'rgb(var(--fg-muted))' }}>
            Connect your wallet (top right) to set up your Nook identity.
          </p>
        )}

        {walletConnected && !signer && (
          <Button onClick={async () => derive()} disabled={deriving}>
            {deriving ? 'Setting up… (check your wallet)' : 'Set up Nook identity'}
          </Button>
        )}

        {signer && myAddress && (
          <>
            {/* Nook address row */}
            <div className="space-y-2">
              <p className="text-xs font-semibold">Nook address</p>
              <p className="text-xs leading-relaxed" style={{ color: 'rgb(var(--fg-muted))' }}>
                Your unique ID on Nook. Publish it so others can add you as a contact just by typing your address — no
                link needed.
              </p>
              <div className="flex items-center gap-2 flex-wrap">
                <code
                  className="flex-1 text-xs font-mono px-3 py-2 rounded-lg border truncate"
                  style={{ backgroundColor: 'rgb(var(--bg))', color: 'rgb(var(--fg))' }}
                >
                  {myAddress}
                </code>
                <button
                  onClick={async () => handleCopy(myAddress, 'address')}
                  className="shrink-0 px-3 py-2 rounded-lg text-xs font-semibold flex items-center gap-1 border"
                  style={{ backgroundColor: 'rgb(var(--bg))', color: 'rgb(var(--fg))' }}
                  aria-label="Copy address"
                >
                  {copied === 'address' ? <Check size={11} /> : <Copy size={11} />}
                  {copied === 'address' ? 'Copied' : 'Copy'}
                </button>
              </div>

              <div className="flex items-center gap-3 pt-1 flex-wrap">
                <span
                  className="inline-flex items-center gap-2 text-xs px-2 py-1 rounded"
                  style={{
                    backgroundColor: published ? 'rgba(34,197,94,0.12)' : 'rgba(255,255,255,0.06)',
                    color: published ? 'rgb(74,222,128)' : 'rgb(var(--fg-muted))',
                  }}
                >
                  <span
                    className="w-1.5 h-1.5 rounded-full"
                    style={{ backgroundColor: published ? 'rgb(34,197,94)' : 'rgb(var(--fg-muted))' }}
                  />
                  {published ? 'Published' : 'Not published'}
                </span>
                <Button variant="outline" size="sm" onClick={handlePublish} disabled={publishing || !stampId}>
                  {publishing ? 'Publishing…' : published ? 'Republish' : 'Publish to identity feed'}
                </Button>
                {!stampId && (
                  <span className="text-xs" style={{ color: 'rgb(var(--fg-muted))' }}>
                    No stamp — publishing needs a drive
                  </span>
                )}
              </div>

              {publishError && (
                <p className="text-xs" style={{ color: 'rgb(248,113,113)' }}>
                  {publishError}
                </p>
              )}
            </div>

            {/* Divider */}
            {myShareLink && <div className="h-px" style={{ backgroundColor: 'rgb(var(--border))' }} />}

            {/* Contact link row */}
            {myShareLink && (
              <div className="space-y-2">
                <p className="text-xs font-semibold">Contact link</p>
                <p className="text-xs leading-relaxed" style={{ color: 'rgb(var(--fg-muted))' }}>
                  Or send the contact link directly — works without publishing and includes everything needed for
                  messaging and drive sharing.
                </p>
                <div className="flex items-center gap-2">
                  <code
                    className="flex-1 text-xs font-mono px-3 py-2 rounded-lg border truncate"
                    style={{ backgroundColor: 'rgb(var(--bg))', color: 'rgb(var(--fg-muted))' }}
                  >
                    {myShareLink}
                  </code>
                  <button
                    onClick={async () => handleCopy(myShareLink, 'share-link')}
                    className="shrink-0 px-3 py-2 rounded-lg text-xs font-semibold flex items-center gap-1"
                    style={{
                      backgroundColor: copied === 'share-link' ? 'rgba(74,222,128,0.15)' : 'rgb(var(--accent))',
                      color: copied === 'share-link' ? '#4ade80' : 'rgb(var(--primary-foreground))',
                    }}
                  >
                    {copied === 'share-link' ? <Check size={11} /> : <Copy size={11} />}
                    {copied === 'share-link' ? 'Copied' : 'Copy'}
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
