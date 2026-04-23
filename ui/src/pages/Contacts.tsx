import { Bee } from '@ethersphere/bee-js'
import { identity } from '@swarm-notify/sdk'
import { Check, Copy, Trash2, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

import { useAddresses, useStamps } from '../api/queries'
import { useDerivedKey } from '../hooks/useDerivedKey'
import { decodeShareLink, encodeShareLink } from '../notify/share-link'
import {
  addContact,
  isIdentityPublished,
  isOnboardingDismissed,
  loadContacts,
  markIdentityPublished,
  markOnboardingDismissed,
  removeContact,
  saveContacts,
} from '../notify/storage'
import type { NookContact } from '../notify/types'

const BEE_URL = `${window.location.origin}/bee-api`

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
}

function short(s: string, n = 6): string {
  return s.length <= n * 2 + 3 ? s : `${s.slice(0, n)}…${s.slice(-n)}`
}

type AddMode = 'registry' | 'share-link'

export default function Contacts() {
  const { signer, derive, walletConnected } = useDerivedKey()
  const { data: addresses } = useAddresses()
  const { data: stamps } = useStamps()

  const bee = useMemo(() => new Bee(BEE_URL), [])
  const [contacts, setContacts] = useState<NookContact[]>(() => loadContacts())

  const [addMode, setAddMode] = useState<AddMode>('registry')

  // Registry mode form
  const [registryAddr, setRegistryAddr] = useState('')
  const [registryNickname, setRegistryNickname] = useState('')

  // Share-link mode form
  const [shareLinkInput, setShareLinkInput] = useState('')
  const [shareLinkOverrideName, setShareLinkOverrideName] = useState('')

  const [adding, setAdding] = useState(false)
  const [addError, setAddError] = useState<string | null>(null)

  // If launched via a nook://contact?... deep link, the URL has ?contact=<encoded>
  // Read it once on mount, switch to share-link mode, prefill the input.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const incoming = params.get('contact')

    if (incoming) {
      setAddMode('share-link')
      setShareLinkInput(incoming)
      // Clean the param from the URL so reloads don't re-prefill
      params.delete('contact')
      const next = params.toString()
      const newSearch = next ? `?${next}` : ''

      window.history.replaceState({}, '', `${window.location.pathname}${newSearch}${window.location.hash}`)
    }
  }, [])

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

  // Compute decoded share-link preview live as the user types
  const decoded = useMemo(() => {
    if (!shareLinkInput.trim()) return null

    return decodeShareLink(shareLinkInput.trim())
  }, [shareLinkInput])

  // Compute my own share link to display + copy
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

  async function handleAddByRegistry() {
    setAddError(null)

    if (!registryAddr.trim() || !registryNickname.trim()) {
      setAddError('Provide both Nook address and nickname')

      return
    }
    setAdding(true)
    try {
      const result = await identity.resolve(bee, registryAddr.trim())

      if (!result) {
        setAddError('No identity found — they must publish, or use a share link instead')

        return
      }
      const next: NookContact = {
        id: registryAddr.trim().toLowerCase(),
        nickname: registryNickname.trim(),
        walletPublicKey: result.walletPublicKey,
        beePublicKey: result.beePublicKey,
        source: 'identity-feed',
        addedAt: Date.now(),
      }
      const updated = addContact(contacts, next)

      setContacts(updated)
      setRegistryAddr('')
      setRegistryNickname('')
    } catch (e) {
      setAddError((e as Error).message)
    } finally {
      setAdding(false)
    }
  }

  function handleAddByShareLink() {
    setAddError(null)

    if (!decoded) {
      setAddError('Paste a share link first')

      return
    }

    if (!decoded.ok) {
      setAddError(decoded.error)

      return
    }
    const nickname =
      shareLinkOverrideName.trim() || decoded.payload.nickname?.trim() || short(decoded.payload.ethAddress)

    try {
      const next: NookContact = {
        id: decoded.payload.ethAddress.toLowerCase(),
        nickname,
        walletPublicKey: decoded.payload.walletPublicKey,
        beePublicKey: decoded.payload.beePublicKey,
        source: 'share-link',
        addedAt: Date.now(),
      }
      const updated = addContact(contacts, next)

      setContacts(updated)
      setShareLinkInput('')
      setShareLinkOverrideName('')
    } catch (e) {
      setAddError((e as Error).message)
    }
  }

  function handleRemoveContact(id: string) {
    const updated = removeContact(contacts, id)

    setContacts(updated)
    saveContacts(updated)
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
  const accentStyle = { backgroundColor: 'rgb(var(--accent))', color: 'rgb(var(--primary-foreground))' }
  const ghostStyle = { backgroundColor: 'rgb(var(--bg))', border: '1px solid rgb(var(--border))' }

  return (
    <div className="p-6 max-w-4xl space-y-4">
      <div>
        <h1 className="text-2xl font-bold mb-1">Contacts</h1>
        <p className="text-sm" style={{ color: 'rgb(var(--fg-muted))' }}>
          People you can send messages to and share drives with. Add by Nook address (identity feed) or share link (manual).
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
            <p className="font-semibold mb-1">Make yourself reachable</p>
            <p style={{ color: 'rgb(var(--fg-muted))' }}>
              Either publish your Nook address to the identity feed (others find you by typing it) or share your contact link
              manually below. Either way works — pick what you prefer.
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
              <button onClick={handlePublish} disabled={publishing || !stampId} className={btnGhost} style={ghostStyle}>
                {publishing ? 'Publishing…' : published ? 'Republish' : 'Publish to identity feed'}
              </button>
              {myShareLink && (
                <button
                  onClick={async () => handleCopy(myShareLink, 'share-link')}
                  className={btnGhost}
                  style={ghostStyle}
                  aria-label="Copy share link"
                >
                  {copied === 'share-link' ? 'Copied' : 'Copy share link'}
                </button>
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
              <strong>send your share link</strong> (others paste it). Both unlock messaging and drive sharing.
              Publishing is voluntary — share-link works without it.
            </p>
          </>
        )}
      </div>

      {/* Add contact */}
      <div className="rounded-xl border p-5 space-y-3" style={cardStyle}>
        <p className="text-xs uppercase tracking-widest" style={{ color: 'rgb(var(--fg-muted))' }}>
          Add contact
        </p>

        <div className="flex gap-4 text-sm">
          <label className="inline-flex items-center gap-2 cursor-pointer">
            <input
              type="radio"
              checked={addMode === 'registry'}
              onChange={() => setAddMode('registry')}
              name="add-mode"
            />
            <span>Find on identity feed</span>
          </label>
          <label className="inline-flex items-center gap-2 cursor-pointer">
            <input
              type="radio"
              checked={addMode === 'share-link'}
              onChange={() => setAddMode('share-link')}
              name="add-mode"
            />
            <span>Paste share link</span>
          </label>
        </div>

        {addMode === 'registry' && (
          <div className="space-y-2">
            <div className="grid grid-cols-1 md:grid-cols-[2fr_1fr] gap-2">
              <input
                type="text"
                className={inputClass}
                style={inputStyle}
                placeholder="Nook address (0x…)"
                value={registryAddr}
                onChange={e => setRegistryAddr(e.target.value)}
                disabled={adding}
              />
              <input
                type="text"
                className={inputClass}
                style={inputStyle}
                placeholder="Nickname"
                value={registryNickname}
                onChange={e => setRegistryNickname(e.target.value)}
                disabled={adding}
              />
            </div>
            <button onClick={handleAddByRegistry} disabled={adding} className={btnGhost} style={ghostStyle}>
              {adding ? 'Looking up…' : 'Look up & add'}
            </button>
          </div>
        )}

        {addMode === 'share-link' && (
          <div className="space-y-2">
            <textarea
              className={`${inputClass} h-20 resize-none`}
              style={inputStyle}
              placeholder="nook://contact?addr=0x…&wpub=…&bpub=…&name=…"
              value={shareLinkInput}
              onChange={e => setShareLinkInput(e.target.value)}
              disabled={adding}
            />
            {decoded && decoded.ok && (
              <div
                className="text-xs space-y-1 p-3 rounded"
                style={{ backgroundColor: 'rgb(var(--bg))', color: 'rgb(var(--fg-muted))' }}
              >
                <p>
                  <span style={{ color: 'rgb(var(--fg))' }}>Address:</span> {decoded.payload.ethAddress}
                </p>
                <p>
                  <span style={{ color: 'rgb(var(--fg))' }}>Suggested nickname:</span>{' '}
                  {decoded.payload.nickname ?? '(none — provide one below)'}
                </p>
                <p style={{ color: 'rgb(74,222,128)' }}>✓ All keys present (wallet + bee)</p>
              </div>
            )}
            {decoded && !decoded.ok && (
              <p className="text-xs" style={{ color: 'rgb(248,113,113)' }}>
                {decoded.error}
              </p>
            )}
            <input
              type="text"
              className={inputClass}
              style={inputStyle}
              placeholder="Override nickname (optional)"
              value={shareLinkOverrideName}
              onChange={e => setShareLinkOverrideName(e.target.value)}
              disabled={adding}
            />
            <button onClick={handleAddByShareLink} disabled={adding} className={btnGhost} style={ghostStyle}>
              Add from share link
            </button>
          </div>
        )}

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
            No contacts yet. Add someone above.
          </p>
        ) : (
          <ul className="divide-y" style={{ borderColor: 'rgb(var(--border))' }}>
            {contacts.map(c => (
              <li key={c.id} className="flex items-center justify-between py-2.5 gap-3">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium truncate">
                    {c.nickname}
                    <span
                      className="ml-2 text-xs px-1.5 py-0.5 rounded"
                      style={{
                        color: 'rgb(var(--fg-muted))',
                        backgroundColor: 'rgba(255,255,255,0.05)',
                      }}
                    >
                      {c.source === 'identity-feed' ? 'identity feed' : 'share link'}
                    </span>
                  </p>
                  <code className="text-xs font-mono" style={{ color: 'rgb(var(--fg-muted))' }}>
                    {short(c.id)}
                  </code>
                </div>
                <button
                  onClick={() => handleRemoveContact(c.id)}
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
