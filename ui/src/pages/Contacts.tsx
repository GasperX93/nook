import { Bee } from '@ethersphere/bee-js'
import { identity } from '@swarm-notify/sdk'
import { Check, Copy, Mail, MessageSquare, Plus, Search, Send, Share2, Trash2, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

import Messages, { ConnectionStatusBadge } from '../apps/Messages'
import { useStamps } from '../api/queries'
import { useDerivedKey } from '../hooks/useDerivedKey'
import { deriveConnectionState, getMyDisplayName } from '../notify/contact-state'
import { sendInviteAck } from '../notify/invite-ack'
import { loadThreads } from '../notify/messages'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { Textarea } from '../components/ui/textarea'
import {
  type Invitation,
  loadInvitations,
  markInvitationProcessed,
  pendingInvitations,
  removeInvitationsFor,
} from '../notify/invitations'
import { decodeShareLink, encodeShareLink } from '../notify/share-link'
import { addContact, loadContacts, removeContact, saveContacts } from '../notify/storage'
import type { NookContact } from '../notify/types'

const BEE_URL = `${window.location.origin}/bee-api`

function short(s: string, n = 6): string {
  return s.length <= n * 2 + 3 ? s : `${s.slice(0, n)}…${s.slice(-n)}`
}

function formatDate(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10)
}

type AddMode = 'registry' | 'share-link'
type SortMode = 'name' | 'date' | 'address'

export default function Contacts() {
  const bee = useMemo(() => new Bee(BEE_URL), [])
  const { signer } = useDerivedKey()
  const { data: stamps } = useStamps()
  const [contacts, setContacts] = useState<NookContact[]>(() => loadContacts())

  // Phase 4: contacts are namespaced per derived identity. When the identity
  // changes (wallet switch/disconnect) the storage namespace flips, so re-read
  // the list — otherwise the page would show the previous wallet's contacts
  // until navigated away. Keyed on the derived address.
  const myAddress = signer ? signer.getAddress() : null

  // Pending invitations — on-chain wake-up pings from senders not yet in
  // contacts. These are the ONLY surface for first-contact invites, so they
  // live here on the Contacts page. Re-read on identity change + a short
  // interval (the registry poll that writes them runs in Layout).
  const [invitations, setInvitations] = useState<Invitation[]>(() => loadInvitations())

  useEffect(() => {
    setContacts(loadContacts())
    setInvitations(loadInvitations())
  }, [myAddress])

  useEffect(() => {
    const id = setInterval(() => {
      setContacts(loadContacts())
      setInvitations(loadInvitations())
    }, 3_000)

    return () => clearInterval(id)
  }, [])

  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [selectedInviteId, setSelectedInviteId] = useState<string | null>(null)
  const [inviteNickname, setInviteNickname] = useState('')
  const [acceptingInvite, setAcceptingInvite] = useState(false)
  const [inviteError, setInviteError] = useState<string | null>(null)
  const [composeFor, setComposeFor] = useState<string | null>(null)
  const [addOpen, setAddOpen] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [sortMode, setSortMode] = useState<SortMode>('name')

  // Add-contact dialog state
  const [addMode, setAddMode] = useState<AddMode>('registry')
  const [registryAddr, setRegistryAddr] = useState('')
  const [registryNickname, setRegistryNickname] = useState('')
  const [shareLinkInput, setShareLinkInput] = useState('')
  const [shareLinkOverrideName, setShareLinkOverrideName] = useState('')
  const [adding, setAdding] = useState(false)
  const [addError, setAddError] = useState<string | null>(null)

  // If launched via a nook://contact?... deep link, the URL has ?contact=<encoded>.
  // Open the add dialog with share-link tab pre-filled.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const incoming = params.get('contact')

    if (incoming) {
      setAddMode('share-link')
      setShareLinkInput(incoming)
      setAddOpen(true)
      params.delete('contact')
      const next = params.toString()
      const newSearch = next ? `?${next}` : ''

      window.history.replaceState({}, '', `${window.location.pathname}${newSearch}${window.location.hash}`)
    }
  }, [])

  const [copied, setCopied] = useState<'detail-address' | 'detail-share' | null>(null)
  const [copiedRowId, setCopiedRowId] = useState<string | null>(null)

  const decoded = useMemo(() => {
    if (!shareLinkInput.trim()) return null

    return decodeShareLink(shareLinkInput.trim())
  }, [shareLinkInput])

  const sortedFilteredContacts = useMemo(() => {
    const q = searchQuery.trim().toLowerCase()
    const filtered = q
      ? contacts.filter(c => c.nickname.toLowerCase().includes(q) || c.id.toLowerCase().includes(q))
      : contacts
    const sorted = [...filtered]

    if (sortMode === 'name') sorted.sort((a, b) => a.nickname.localeCompare(b.nickname))

    if (sortMode === 'date') sorted.sort((a, b) => b.addedAt - a.addedAt)

    if (sortMode === 'address') sorted.sort((a, b) => a.id.localeCompare(b.id))

    return sorted
  }, [contacts, searchQuery, sortMode])

  const selected = useMemo(() => contacts.find(c => c.id === selectedId) ?? null, [contacts, selectedId])

  // Pending invitations from senders not already in contacts (a contact's
  // messages arrive via the mailbox, so a stale invite row would just shadow
  // the real thread).
  const pending = useMemo(() => {
    const known = new Set(contacts.map(c => c.id.toLowerCase()))

    return pendingInvitations(invitations).filter(i => !known.has(i.senderAddr))
  }, [invitations, contacts])
  const selectedInvite = useMemo(
    () => (selectedInviteId ? (pending.find(i => i.senderAddr === selectedInviteId) ?? null) : null),
    [pending, selectedInviteId],
  )

  // Selecting a contact and selecting an invitation are mutually exclusive.
  function selectContact(id: string) {
    setSelectedId(id)
    setSelectedInviteId(null)
  }

  function selectInvite(senderAddr: string) {
    setSelectedInviteId(senderAddr)
    setSelectedId(null)
    setInviteNickname('')
    setInviteError(null)
  }

  // Reset compose mode when selection changes
  useEffect(() => {
    setComposeFor(null)
  }, [selectedId])

  async function handleAcceptInvite() {
    if (!selectedInvite || !inviteNickname.trim()) return
    setAcceptingInvite(true)
    setInviteError(null)
    try {
      // Resolve the sender's identity feed to get their wallet + bee public keys.
      const resolved = await identity.resolve(bee, selectedInvite.senderAddr)

      if (!resolved) {
        setInviteError('Could not resolve sender identity. They may have unpublished.')

        return
      }
      const senderContact: NookContact = {
        id: selectedInvite.senderAddr,
        nickname: inviteNickname.trim(),
        walletPublicKey: resolved.walletPublicKey,
        beePublicKey: resolved.beePublicKey,
        source: 'identity-feed',
        addedAt: Date.now(),
      }
      const updated = addContact(contacts, senderContact)

      setContacts(updated)
      const nextInvs = markInvitationProcessed(loadInvitations(), selectedInvite.senderAddr)

      setInvitations(nextInvs)
      selectContact(selectedInvite.senderAddr) // drop into the new conversation

      // Tell the sender we accepted — flips their side from "waiting" to
      // "connected" (best-effort; no on-chain cost, we're mutual contacts now).
      const stampId = (stamps ?? []).find(s => s.usable)?.batchID ?? ''

      if (signer) void sendInviteAck(bee, signer, stampId, senderContact, getMyDisplayName())
    } catch (e) {
      setInviteError((e as Error).message ?? 'Failed to add contact')
    } finally {
      setAcceptingInvite(false)
    }
  }

  function handleDismissInvite(senderAddr: string) {
    // removeInvitationsFor persists internally.
    setInvitations(removeInvitationsFor(loadInvitations(), senderAddr))

    if (selectedInviteId === senderAddr) setSelectedInviteId(null)
  }

  // Show the message thread if the contact already has history OR the user just hit Send message.
  const { hasThread, hasInbound } = useMemo(() => {
    if (!selectedId) return { hasThread: false, hasInbound: false }
    const t = loadThreads()[selectedId.toLowerCase()] ?? []

    return { hasThread: t.length > 0, hasInbound: t.some(m => m.direction === 'received') }
  }, [selectedId, composeFor])
  const showThread = hasThread || composeFor === selectedId
  const connectionState = selectedId ? deriveConnectionState(selectedId, hasInbound) : 'not-connected'

  function resetAddForm() {
    setRegistryAddr('')
    setRegistryNickname('')
    setShareLinkInput('')
    setShareLinkOverrideName('')
    setAddError(null)
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
        setAddError('No identity found — they must publish, or use a contact link instead')

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
      resetAddForm()
      setAddOpen(false)
    } catch (e) {
      setAddError((e as Error).message)
    } finally {
      setAdding(false)
    }
  }

  function handleAddByShareLink() {
    setAddError(null)

    if (!decoded) {
      setAddError('Paste a contact link first')

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
      resetAddForm()
      setAddOpen(false)
    } catch (e) {
      setAddError((e as Error).message)
    }
  }

  function handleRemoveContact(id: string) {
    const updated = removeContact(contacts, id)

    setContacts(updated)
    saveContacts(updated)
    removeInvitationsFor(loadInvitations(), id)

    if (selectedId === id) setSelectedId(null)
  }

  async function handleCopy(value: string, kind: 'detail-address' | 'detail-share') {
    await navigator.clipboard.writeText(value)
    setCopied(kind)
    setTimeout(() => setCopied(null), 1500)
  }

  function handleShareContact(c: NookContact) {
    const link = encodeShareLink({
      ethAddress: c.id,
      walletPublicKey: c.walletPublicKey,
      beePublicKey: c.beePublicKey,
      nickname: c.nickname,
    })

    void handleCopy(link, 'detail-share')
  }

  return (
    <div className="flex h-full">
      {/* LEFT PANE (50%) */}
      <div
        className="flex-1 basis-1/2 min-w-0 border-r overflow-y-auto p-5 space-y-4"
        style={{ borderColor: 'rgb(var(--border))' }}
      >
        {/* Header row: title + search + Add contact */}
        <div className="flex items-center gap-2">
          <h1 className="text-lg font-semibold">Contacts</h1>
          <div className="ml-auto flex items-center gap-2">
            <Button
              size="icon"
              variant="ghost"
              onClick={() => setSearchOpen(v => !v)}
              aria-label="Toggle search"
              className="h-8 w-8"
            >
              <Search size={14} />
            </Button>
            <Button size="sm" onClick={() => setAddOpen(true)} className="inline-flex items-center gap-1.5">
              <Plus size={14} />
              Add contact
            </Button>
            <select
              value={sortMode}
              onChange={e => setSortMode(e.target.value as SortMode)}
              className="text-xs h-8 rounded border bg-transparent px-2 cursor-pointer focus:outline-none"
              style={{ color: 'rgb(var(--fg-muted))', borderColor: 'rgb(var(--border))' }}
              aria-label="Sort contacts"
            >
              <option value="name">Sort: Name</option>
              <option value="date">Sort: Date added</option>
              <option value="address">Sort: Nook address</option>
            </select>
          </div>
        </div>

        {searchOpen && (
          <Input
            autoFocus
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            placeholder="Search by name or Nook address"
          />
        )}

        {/* Pending invitations — first-contact wake-ups from people not yet
            in contacts. Shown here because there's no separate Messages nav. */}
        {pending.length > 0 && (
          <div className="rounded-lg border overflow-hidden" style={{ borderColor: 'rgb(74,222,128,0.4)' }}>
            <div
              className="px-3 py-2 text-[10px] uppercase tracking-widest flex items-center gap-1.5"
              style={{ color: 'rgb(74,222,128)', backgroundColor: 'rgba(74,222,128,0.08)' }}
            >
              <Mail size={12} />
              {pending.length === 1 ? 'New invitation' : `${pending.length} new invitations`}
            </div>
            <ul className="divide-y" style={{ borderColor: 'rgb(var(--border))' }}>
              {pending.map(inv => {
                const isSelected = selectedInviteId === inv.senderAddr

                return (
                  <li key={inv.senderAddr}>
                    <div
                      role="button"
                      tabIndex={0}
                      onClick={() => selectInvite(inv.senderAddr)}
                      onKeyDown={e => (e.key === 'Enter' || e.key === ' ') && selectInvite(inv.senderAddr)}
                      className="px-3 py-2.5 w-full text-left hover:bg-white/5 cursor-pointer flex flex-col gap-0.5"
                      style={{ backgroundColor: isSelected ? 'rgba(74,222,128,0.1)' : 'transparent' }}
                    >
                      <span className="text-sm font-medium">Someone wants to reach you</span>
                      <span className="text-xs font-mono truncate" style={{ color: 'rgb(var(--fg-muted))' }}>
                        {short(inv.senderAddr, 6)}
                      </span>
                    </div>
                  </li>
                )
              })}
            </ul>
          </div>
        )}

        {/* Table */}
        {sortedFilteredContacts.length === 0 ? (
          <p className="text-xs px-2 py-6 text-center" style={{ color: 'rgb(var(--fg-muted))' }}>
            {contacts.length === 0
              ? 'No contacts yet. Click "Add contact" to begin.'
              : 'No contacts match this search.'}
          </p>
        ) : (
          <div className="rounded-lg border overflow-hidden" style={{ borderColor: 'rgb(var(--border))' }}>
            <div
              className="grid grid-cols-[1fr_110px_140px] gap-2 px-3 py-2 text-[10px] uppercase tracking-widest items-center"
              style={{ color: 'rgb(var(--fg-muted))', backgroundColor: 'rgb(var(--bg))' }}
            >
              <div>Name</div>
              <div>Date added</div>
              <div>Nook address</div>
            </div>
            <ul className="divide-y" style={{ borderColor: 'rgb(var(--border))' }}>
              {sortedFilteredContacts.map(c => {
                const isSelected = selectedId === c.id
                const isCopied = copiedRowId === c.id

                return (
                  <li key={c.id}>
                    <div
                      role="button"
                      tabIndex={0}
                      onClick={() => selectContact(c.id)}
                      onKeyDown={e => (e.key === 'Enter' || e.key === ' ') && selectContact(c.id)}
                      className="grid grid-cols-[1fr_110px_140px] gap-2 px-3 py-2.5 w-full text-left items-center hover:bg-white/5 cursor-pointer"
                      style={{
                        backgroundColor: isSelected ? 'rgba(255,255,255,0.06)' : 'transparent',
                      }}
                    >
                      <span className="text-sm font-medium truncate">{c.nickname}</span>
                      <span className="text-xs font-mono" style={{ color: 'rgb(var(--fg-muted))' }}>
                        {formatDate(c.addedAt)}
                      </span>
                      <div className="flex items-center gap-1.5 min-w-0">
                        <span className="text-xs font-mono truncate" style={{ color: 'rgb(var(--fg-muted))' }}>
                          {short(c.id, 4)}
                        </span>
                        <button
                          onClick={async e => {
                            e.stopPropagation()
                            await navigator.clipboard.writeText(c.id)
                            setCopiedRowId(c.id)
                            setTimeout(() => setCopiedRowId(curr => (curr === c.id ? null : curr)), 1500)
                          }}
                          className="shrink-0 p-1 rounded hover:bg-white/10"
                          aria-label={`Copy Nook address for ${c.nickname}`}
                          title="Copy Nook address"
                        >
                          {isCopied ? (
                            <Check size={12} style={{ color: 'rgb(74,222,128)' }} />
                          ) : (
                            <Copy size={12} style={{ color: 'rgb(var(--fg-muted))' }} />
                          )}
                        </button>
                      </div>
                    </div>
                  </li>
                )
              })}
            </ul>
          </div>
        )}
      </div>

      {/* RIGHT PANE (50%) */}
      <div className="flex-1 basis-1/2 flex flex-col min-w-0 overflow-hidden">
        {selectedInvite ? (
          <div className="flex-1 flex items-center justify-center p-8 overflow-y-auto">
            <div className="w-full max-w-md space-y-5">
              <div className="text-center space-y-2">
                <div
                  className="w-12 h-12 rounded-full flex items-center justify-center mx-auto"
                  style={{ backgroundColor: 'rgba(74,222,128,0.15)' }}
                >
                  <Mail size={22} style={{ color: 'rgb(74,222,128)' }} />
                </div>
                <p className="text-lg font-semibold">Someone wants to reach you</p>
                {/* Security (D4): show the address, never a sender-supplied name,
                    until the user accepts and we resolve the published identity. */}
                <code className="text-xs font-mono break-all block" style={{ color: 'rgb(var(--fg-muted))' }}>
                  {selectedInvite.senderAddr}
                </code>
                <p className="text-xs" style={{ color: 'rgb(var(--fg-muted))' }}>
                  Accept to add them as a contact and open the conversation. Give them a nickname:
                </p>
              </div>
              <Input
                autoFocus
                value={inviteNickname}
                onChange={e => setInviteNickname(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && void handleAcceptInvite()}
                placeholder="Nickname"
                disabled={acceptingInvite}
              />
              {inviteError && (
                <p className="text-xs" style={{ color: 'rgb(248,113,113)' }}>
                  {inviteError}
                </p>
              )}
              <div className="flex items-center justify-center gap-2">
                <Button
                  onClick={handleAcceptInvite}
                  disabled={acceptingInvite || !inviteNickname.trim()}
                  className="inline-flex items-center gap-1.5"
                >
                  <Check size={14} />
                  {acceptingInvite ? 'Accepting…' : 'Accept invitation'}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => handleDismissInvite(selectedInvite.senderAddr)}
                  disabled={acceptingInvite}
                  className="inline-flex items-center gap-1.5 text-red-500"
                >
                  <Trash2 size={14} />
                  Dismiss
                </Button>
              </div>
            </div>
          </div>
        ) : !selected ? (
          <div className="flex-1 flex items-center justify-center p-8">
            <p className="text-sm" style={{ color: 'rgb(var(--fg-muted))' }}>
              Select a contact to see their details
            </p>
          </div>
        ) : showThread ? (
          <>
            {/* Header — single-line, mirrors the left pane's 'Contacts' + actions row */}
            <div className="p-5 pb-4 shrink-0">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-3 min-w-0">
                  <h1 className="text-lg font-semibold truncate">{selected.nickname}</h1>
                  <ConnectionStatusBadge state={connectionState} contactId={selected.id} />
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handleShareContact(selected)}
                    className="inline-flex items-center gap-1.5"
                  >
                    <Share2 size={14} />
                    {copied === 'detail-share' ? 'Copied' : 'Share contact'}
                  </Button>
                  <Button
                    variant="outline"
                    size="icon"
                    onClick={() => handleRemoveContact(selected.id)}
                    aria-label={`Remove ${selected.nickname}`}
                    className="text-red-500 h-8 w-8"
                  >
                    <Trash2 size={14} />
                  </Button>
                </div>
              </div>
            </div>
            <div className="flex-1 min-h-0 border-t" style={{ borderColor: 'rgb(var(--border))' }}>
              <Messages key={selected.id} initialContactId={selected.id} hideContactList hideThreadHeader />
            </div>
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center p-8 overflow-y-auto">
            <div className="w-full max-w-md space-y-5">
              <div
                className="w-48 h-48 mx-auto rounded-lg"
                style={{ backgroundColor: 'rgb(0,0,0)' }}
                aria-label="Contact avatar"
              />
              <div className="text-center space-y-2">
                <p className="text-xl font-semibold">{selected.nickname}</p>
                <div className="flex items-center justify-center gap-2">
                  <code className="text-xs font-mono break-all" style={{ color: 'rgb(var(--fg-muted))' }}>
                    {selected.id}
                  </code>
                  <button
                    onClick={async () => handleCopy(selected.id, 'detail-address')}
                    className="p-1 rounded hover:opacity-70 inline-flex items-center gap-1 text-xs"
                    style={{ color: 'rgb(var(--fg-muted))' }}
                    aria-label="Copy address"
                  >
                    {copied === 'detail-address' ? <Check size={12} /> : <Copy size={12} />}
                  </button>
                </div>
                <p className="text-xs" style={{ color: 'rgb(var(--fg-muted))' }}>
                  Date added {formatDate(selected.addedAt)}
                </p>
              </div>
              <div className="flex items-center justify-center gap-2 pt-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setComposeFor(selected.id)}
                  className="inline-flex items-center gap-1.5"
                >
                  <MessageSquare size={14} />
                  Send message
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => handleShareContact(selected)}
                  className="inline-flex items-center gap-1.5"
                >
                  <Share2 size={14} />
                  {copied === 'detail-share' ? 'Copied' : 'Share contact'}
                </Button>
                <Button
                  variant="outline"
                  size="icon"
                  onClick={() => handleRemoveContact(selected.id)}
                  aria-label={`Remove ${selected.nickname}`}
                  className="text-red-500 h-9 w-9"
                >
                  <Trash2 size={14} />
                </Button>
              </div>
              <p className="text-[11px] text-center" style={{ color: 'rgb(var(--fg-muted))' }}>
                Added via {selected.source === 'identity-feed' ? 'identity feed' : 'contact link'}
              </p>
            </div>
          </div>
        )}
      </div>

      {/* ADD CONTACT MODAL */}
      {addOpen && (
        <div
          className="fixed inset-0 flex items-center justify-center z-50"
          style={{ backgroundColor: 'rgba(0,0,0,0.6)' }}
          onClick={() => setAddOpen(false)}
        >
          <div
            className="rounded-xl border p-6 w-[460px] space-y-5"
            style={{ backgroundColor: 'rgb(var(--bg-surface))' }}
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <p className="text-sm font-semibold">Add contact</p>
              <Button onClick={() => setAddOpen(false)} variant="ghost" size="icon" className="h-8 w-8">
                <X size={16} />
              </Button>
            </div>

            <div className="flex gap-4 text-sm">
              <label className="inline-flex items-center gap-2 cursor-pointer">
                <input
                  type="radio"
                  checked={addMode === 'registry'}
                  onChange={() => setAddMode('registry')}
                  name="add-mode"
                />
                <span>Find by Nook address</span>
              </label>
              <label className="inline-flex items-center gap-2 cursor-pointer">
                <input
                  type="radio"
                  checked={addMode === 'share-link'}
                  onChange={() => setAddMode('share-link')}
                  name="add-mode"
                />
                <span>Paste contact link</span>
              </label>
            </div>

            {addMode === 'registry' && (
              <div className="space-y-2">
                <Input
                  placeholder="Nook address (0x…)"
                  value={registryAddr}
                  onChange={e => setRegistryAddr(e.target.value)}
                  disabled={adding}
                />
                <Input
                  placeholder="Nickname"
                  value={registryNickname}
                  onChange={e => setRegistryNickname(e.target.value)}
                  disabled={adding}
                />
                <Button onClick={handleAddByRegistry} disabled={adding} className="inline-flex items-center gap-1.5">
                  <Send size={14} />
                  {adding ? 'Looking up…' : 'Look up & add'}
                </Button>
              </div>
            )}

            {addMode === 'share-link' && (
              <div className="space-y-2">
                <Textarea
                  className="h-20 resize-none font-mono text-xs"
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
                <Input
                  placeholder="Override nickname (optional)"
                  value={shareLinkOverrideName}
                  onChange={e => setShareLinkOverrideName(e.target.value)}
                  disabled={adding}
                />
                <Button onClick={handleAddByShareLink} disabled={adding}>
                  Add from contact link
                </Button>
              </div>
            )}

            {addError && (
              <p className="text-xs" style={{ color: 'rgb(248,113,113)' }}>
                {addError}
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
