import { Bee } from '@ethersphere/bee-js'
import { identity } from '@swarm-notify/sdk'
import { Check, Copy, Trash2, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

import { useAddresses, useStamps } from '../api/queries'
import { useDerivedKey } from '../hooks/useDerivedKey'
import {
  isIdentityPublished,
  isOnboardingDismissed,
  loadContactStore,
  markIdentityPublished,
  markOnboardingDismissed,
  saveContactStore,
} from '../notify/storage'

const BEE_URL = `${window.location.origin}/bee-api`

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
}

function short(s: string, n = 6): string {
  return s.length <= n * 2 + 3 ? s : `${s.slice(0, n)}…${s.slice(-n)}`
}

export default function Contacts() {
  const { signer, derive, walletConnected } = useDerivedKey()
  const { data: addresses } = useAddresses()
  const { data: stamps } = useStamps()

  const bee = useMemo(() => new Bee(BEE_URL), [])
  const [contactStore] = useState(() => loadContactStore())
  const [, setContactsTick] = useState(0)
  const refreshContacts = () => setContactsTick(t => t + 1)
  const persist = () => saveContactStore(contactStore)

  const [contactAddr, setContactAddr] = useState('')
  const [contactNickname, setContactNickname] = useState('')
  const [adding, setAdding] = useState(false)
  const [addError, setAddError] = useState<string | null>(null)

  const [publishing, setPublishing] = useState(false)
  const [publishError, setPublishError] = useState<string | null>(null)
  const [publishedTick, setPublishedTick] = useState(0)

  const [copied, setCopied] = useState(false)
  const [hintDismissed, setHintDismissed] = useState(() => isOnboardingDismissed())

  const usableStamps = (stamps ?? []).filter(s => s.usable)
  const stampId = usableStamps[0]?.batchID ?? null
  const myAddress = signer?.getAddress() ?? null
  const published = myAddress ? isIdentityPublished(myAddress) : false

  // re-read published flag on mount + after publish
  useEffect(() => {
    void publishedTick
  }, [publishedTick])

  const contacts = contactStore.list()

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
        overlay: addresses.overlay,
        ethAddress: signer.getAddress(),
      })
      // Verify by reading back
      const readback = await identity.resolve(bee, signer.getAddress())

      if (!readback) {
        setPublishError('Published but could not verify — try again')

        return
      }
      markIdentityPublished(signer.getAddress())
      setPublishedTick(t => t + 1)
      // dismiss the onboarding hint once published
      markOnboardingDismissed()
      setHintDismissed(true)
    } catch (e) {
      setPublishError((e as Error).message)
    } finally {
      setPublishing(false)
    }
  }

  async function handleAddContact() {
    setAddError(null)

    if (!contactAddr.trim() || !contactNickname.trim()) {
      setAddError('Provide both Nook address and nickname')

      return
    }
    setAdding(true)
    try {
      const result = await identity.resolve(bee, contactAddr.trim())

      if (!result) {
        setAddError('No identity found — they must publish first')

        return
      }
      contactStore.add(contactAddr.trim(), contactNickname.trim(), result)
      persist()
      refreshContacts()
      setContactAddr('')
      setContactNickname('')
    } catch (e) {
      setAddError((e as Error).message)
    } finally {
      setAdding(false)
    }
  }

  function handleRemoveContact(addr: string) {
    contactStore.remove(addr)
    persist()
    refreshContacts()
  }

  async function handleCopyAddress() {
    if (!myAddress) return
    await navigator.clipboard.writeText(myAddress)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  function handleDismissHint() {
    markOnboardingDismissed()
    setHintDismissed(true)
  }

  const cardStyle = { backgroundColor: 'rgb(var(--bg-surface))' }
  const inputStyle = {
    backgroundColor: 'rgb(var(--bg))',
    color: 'rgb(var(--fg))',
    borderColor: 'rgb(var(--border))',
  }
  const inputClass = 'rounded border px-3 py-2 text-sm font-mono focus:outline-none w-full'
  const btnPrimary =
    'px-4 py-2 rounded text-xs font-semibold uppercase tracking-widest transition-opacity disabled:opacity-40 disabled:cursor-not-allowed'
  const btnGhost =
    'px-3 py-1.5 rounded text-xs font-semibold uppercase tracking-widest transition-opacity disabled:opacity-40 disabled:cursor-not-allowed'
  const accentStyle = { backgroundColor: 'rgb(var(--accent))', color: '#fff' }
  const ghostStyle = { backgroundColor: 'rgb(var(--bg))', border: '1px solid rgb(var(--border))' }

  return (
    <div className="p-6 max-w-4xl space-y-4">
      <div>
        <h1 className="text-2xl font-bold mb-1">Contacts</h1>
        <p className="text-sm" style={{ color: 'rgb(var(--fg-muted))' }}>
          People you can send messages to. Add by Nook address.
        </p>
      </div>

      {/* Onboarding hint */}
      {!hintDismissed && !published && (
        <div
          className="rounded-xl border p-4 flex items-start gap-3"
          style={{
            backgroundColor: 'rgba(247,104,8,0.06)',
            borderColor: 'rgba(247,104,8,0.3)',
          }}
        >
          <div className="flex-1 text-sm">
            <p className="font-semibold mb-1">Publish your Nook address to receive messages</p>
            <p style={{ color: 'rgb(var(--fg-muted))' }}>
              Others can find you by your Nook address only after you publish your identity. This is voluntary — skip if
              you prefer to stay private.
            </p>
          </div>
          <button onClick={handleDismissHint} aria-label="Dismiss" className="p-1 hover:opacity-60">
            <X size={16} />
          </button>
        </div>
      )}

      {/* My identity */}
      <div className="rounded-xl border p-5 space-y-3" style={cardStyle}>
        <p className="text-xs uppercase tracking-widest" style={{ color: 'rgb(var(--fg-muted))' }}>
          Your Nook address
        </p>

        {!walletConnected && (
          <p className="text-sm" style={{ color: 'rgb(var(--fg-muted))' }}>
            Connect your wallet (top right) to derive your Nook address.
          </p>
        )}

        {walletConnected && !signer && (
          <button onClick={derive} className={btnPrimary} style={accentStyle}>
            Derive key
          </button>
        )}

        {signer && myAddress && (
          <>
            <div className="flex items-center gap-2 flex-wrap">
              <code className="text-sm font-mono break-all" style={{ color: 'rgb(var(--fg))' }}>
                {myAddress}
              </code>
              <button
                onClick={handleCopyAddress}
                className="p-1.5 rounded hover:opacity-70 inline-flex items-center gap-1 text-xs"
                style={{ backgroundColor: 'rgb(var(--bg))', color: 'rgb(var(--fg-muted))' }}
                aria-label="Copy address"
              >
                {copied ? <Check size={12} /> : <Copy size={12} />}
                <span>{copied ? 'Copied' : 'Copy'}</span>
              </button>
            </div>

            <div className="flex items-center gap-3 pt-2">
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
              <button onClick={handlePublish} disabled={publishing || !stampId} className={btnGhost} style={ghostStyle}>
                {publishing ? 'Publishing…' : published ? 'Republish' : 'Publish my Nook address'}
              </button>
              {!stampId && (
                <span className="text-xs" style={{ color: 'rgb(var(--fg-muted))' }}>
                  No stamp — buy a drive first
                </span>
              )}
            </div>

            {publishError && (
              <p className="text-xs" style={{ color: 'rgb(248,113,113)' }}>
                {publishError}
              </p>
            )}

            <p className="text-xs leading-relaxed" style={{ color: 'rgb(var(--fg-muted))' }}>
              Publishing makes your Nook address resolvable on Swarm — others can look you up by this address and send
              you messages. This is different from your wallet address. Voluntary; you can skip publishing and still
              send messages, but no one will be able to message you.
            </p>
          </>
        )}
      </div>

      {/* Add contact */}
      <div className="rounded-xl border p-5 space-y-3" style={cardStyle}>
        <p className="text-xs uppercase tracking-widest" style={{ color: 'rgb(var(--fg-muted))' }}>
          Add contact
        </p>
        <div className="grid grid-cols-1 md:grid-cols-[2fr_1fr] gap-2">
          <input
            type="text"
            className={inputClass}
            style={inputStyle}
            placeholder="Nook address (0x…)"
            value={contactAddr}
            onChange={e => setContactAddr(e.target.value)}
            disabled={adding}
          />
          <input
            type="text"
            className={inputClass}
            style={inputStyle}
            placeholder="Nickname"
            value={contactNickname}
            onChange={e => setContactNickname(e.target.value)}
            disabled={adding}
          />
        </div>
        <button onClick={handleAddContact} disabled={adding} className={btnGhost} style={ghostStyle}>
          {adding ? 'Looking up…' : 'Add contact'}
        </button>
        {addError && (
          <p className="text-xs" style={{ color: 'rgb(248,113,113)' }}>
            {addError}
          </p>
        )}
      </div>

      {/* Contact list */}
      <div className="rounded-xl border p-5 space-y-3" style={cardStyle}>
        <p className="text-xs uppercase tracking-widest" style={{ color: 'rgb(var(--fg-muted))' }}>
          Saved contacts ({contacts.length})
        </p>
        {contacts.length === 0 ? (
          <p className="text-sm" style={{ color: 'rgb(var(--fg-muted))' }}>
            No contacts yet. Add someone above by pasting their Nook address.
          </p>
        ) : (
          <ul className="divide-y" style={{ borderColor: 'rgb(var(--border))' }}>
            {contacts.map(c => (
              <li key={c.ethAddress} className="flex items-center justify-between py-2.5 gap-3">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium truncate">{c.nickname}</p>
                  <code className="text-xs font-mono" style={{ color: 'rgb(var(--fg-muted))' }}>
                    {short(c.ethAddress)}
                  </code>
                </div>
                <button
                  onClick={() => handleRemoveContact(c.ethAddress)}
                  className="p-2 rounded hover:opacity-70 text-xs inline-flex items-center gap-1"
                  style={{ color: 'rgb(var(--fg-muted))' }}
                  aria-label={`Remove ${c.nickname}`}
                >
                  <Trash2 size={14} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
