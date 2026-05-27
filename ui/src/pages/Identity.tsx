import { Bee } from '@ethersphere/bee-js'
import { identity } from '@swarm-notify/sdk'
import { Check, Copy, Key, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

import { useAddresses, useStamps } from '../api/queries'
import { Button } from '../components/ui/button'
import { useDerivedKey } from '../hooks/useDerivedKey'
import { encodeShareLink } from '../notify/share-link'
import {
  isIdentityPublished,
  isOnboardingDismissed,
  markIdentityPublished,
  markOnboardingDismissed,
} from '../notify/storage'

const BEE_URL = `${window.location.origin}/bee-api`

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
}

export default function Identity() {
  const { signer, derive, walletConnected } = useDerivedKey()
  const { data: addresses } = useAddresses()
  const { data: stamps } = useStamps()

  const bee = useMemo(() => new Bee(BEE_URL), [])

  const [publishing, setPublishing] = useState(false)
  const [publishError, setPublishError] = useState<string | null>(null)
  const [publishedTick, setPublishedTick] = useState(0)
  const [copied, setCopied] = useState<'address' | 'share-link' | 'sharing-key' | null>(null)
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

  async function handleCopy(value: string, kind: 'address' | 'share-link' | 'sharing-key') {
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

      <div className="rounded-xl border p-5 space-y-3" style={{ backgroundColor: 'rgb(var(--bg-surface))' }}>
        <p className="text-xs uppercase tracking-widest" style={{ color: 'rgb(var(--fg-muted))' }}>
          Your Nook address
        </p>

        {!walletConnected && (
          <p className="text-sm" style={{ color: 'rgb(var(--fg-muted))' }}>
            Connect your wallet (top right) to set up your Nook identity.
          </p>
        )}

        {walletConnected && !signer && <Button onClick={derive}>Set up Nook identity</Button>}

        {signer && myAddress && (
          <>
            <div className="flex items-center gap-2 flex-wrap">
              <code className="text-sm font-mono break-all">{myAddress}</code>
              <button
                onClick={async () => handleCopy(myAddress, 'address')}
                className="p-1.5 rounded hover:opacity-70 inline-flex items-center gap-1 text-xs"
                style={{ backgroundColor: 'rgb(var(--bg))', color: 'rgb(var(--fg-muted))' }}
                aria-label="Copy address"
              >
                {copied === 'address' ? <Check size={12} /> : <Copy size={12} />}
                <span>{copied === 'address' ? 'Copied' : 'Copy'}</span>
              </button>
            </div>

            <div className="flex items-center gap-3 pt-2 flex-wrap">
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
              {myShareLink && (
                <Button variant="outline" size="sm" onClick={async () => handleCopy(myShareLink, 'share-link')}>
                  {copied === 'share-link' ? 'Copied' : 'Copy contact link'}
                </Button>
              )}
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

            <p className="text-xs leading-relaxed" style={{ color: 'rgb(var(--fg-muted))' }}>
              Two ways to be reachable: <strong>publish to the identity feed</strong> (others type your Nook address) or{' '}
              <strong>send your contact link</strong> (others paste it). Both unlock messaging and drive sharing.
              Publishing is voluntary — the contact link works without it.
            </p>
          </>
        )}
      </div>

      {addresses?.publicKey && (
        <div className="rounded-xl border p-5" style={{ backgroundColor: 'rgb(var(--bg-surface))' }}>
          <div className="flex items-center gap-2 mb-2">
            <Key size={13} style={{ color: 'rgb(var(--fg-muted))' }} />
            <p className="text-xs uppercase tracking-widest" style={{ color: 'rgb(var(--fg-muted))' }}>
              Sharing key
            </p>
          </div>
          <p className="text-xs mb-3" style={{ color: 'rgb(var(--fg-muted))' }}>
            Share this key with others so they can grant you access to encrypted drives.
          </p>
          <div className="flex items-center gap-2">
            <code
              className="flex-1 text-xs font-mono px-3 py-2 rounded-lg border truncate"
              style={{ backgroundColor: 'rgb(var(--bg))', color: 'rgb(var(--fg-muted))' }}
            >
              {addresses.publicKey}
            </code>
            <button
              onClick={async () => handleCopy(addresses.publicKey, 'sharing-key')}
              className="shrink-0 px-3 py-2 rounded-lg text-xs font-semibold flex items-center gap-1"
              style={{
                backgroundColor: copied === 'sharing-key' ? 'rgba(74,222,128,0.15)' : 'rgb(var(--accent))',
                color: copied === 'sharing-key' ? '#4ade80' : 'rgb(var(--primary-foreground))',
              }}
            >
              {copied === 'sharing-key' ? <Check size={11} /> : <Copy size={11} />}
              {copied === 'sharing-key' ? 'Copied' : 'Copy'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
