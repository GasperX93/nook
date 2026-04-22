import { Bee } from '@ethersphere/bee-js'
import { identity, mailbox } from '@swarm-notify/sdk'
import { FileText, Mail, Send } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'

import { useStamps } from '../api/queries'
import AddSharedDriveModal from '../components/AddSharedDriveModal'
import { useSharedDrives } from '../hooks/useSharedDrives'
import { useDerivedKey } from '../hooks/useDerivedKey'
import { loadInvitations, markInvitationProcessed, pendingInvitations, type Invitation } from '../notify/invitations'
import { appendSent, loadReadCursors, loadThreads, markRead, unreadCount } from '../notify/messages'
import { addContact, loadContacts } from '../notify/storage'
import { toLibraryContact, type NookContact } from '../notify/types'

const BEE_URL = `${window.location.origin}/bee-api`

function short(s: string, n = 6): string {
  return s.length <= n * 2 + 3 ? s : `${s.slice(0, n)}…${s.slice(-n)}`
}

function formatTime(ts: number): string {
  const d = new Date(ts)
  const today = new Date()
  const sameDay = d.toDateString() === today.toDateString()

  return sameDay ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : d.toLocaleString()
}

export default function Messages() {
  const { signer, derive, walletConnected } = useDerivedKey()
  const { data: stamps } = useStamps()

  const bee = useMemo(() => new Bee(BEE_URL), [])
  // Re-read each render cycle so newly-added contacts (eg via accepting an
  // invitation) appear without a remount.
  const [contacts, setContacts] = useState<NookContact[]>(() => loadContacts())
  const [invitations, setInvitations] = useState<Invitation[]>(() => loadInvitations())

  const [threads, setThreads] = useState(() => loadThreads())
  const [cursors, setCursors] = useState(() => loadReadCursors())
  const [selectedId, setSelectedId] = useState<string | null>(contacts[0]?.id ?? null)
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Pre-filled share link when the user clicks "Add drive" on a drive-share card
  const [importingLink, setImportingLink] = useState<string | null>(null)
  // Invitation acceptance state — nickname input + in-flight flag
  const [inviteNickname, setInviteNickname] = useState('')
  const [acceptingInvite, setAcceptingInvite] = useState(false)
  const sharedDrives = useSharedDrives()
  const scrollRef = useRef<HTMLDivElement>(null)

  const pending = useMemo(() => pendingInvitations(invitations), [invitations])

  const stampId = (stamps ?? []).find(s => s.usable)?.batchID ?? ''
  const selected = contacts.find(c => c.id === selectedId) ?? null
  const selectedThread = selected ? (threads[selected.id.toLowerCase()] ?? []) : []
  // If the selected entry isn't a contact, it might be a pending invitation.
  const selectedInvite = !selected ? (pending.find(i => i.senderAddr === selectedId?.toLowerCase()) ?? null) : null

  async function handleAcceptInvite() {
    if (!selectedInvite || !inviteNickname.trim()) return
    setAcceptingInvite(true)
    setError(null)
    try {
      // Resolve sender's identity via their feed to get wpub + bpub
      const resolved = await identity.resolve(bee, selectedInvite.senderAddr)

      if (!resolved) {
        setError('Could not resolve sender identity. They may have unpublished.')

        return
      }

      const next = addContact(contacts, {
        id: selectedInvite.senderAddr,
        nickname: inviteNickname.trim(),
        walletPublicKey: resolved.walletPublicKey,
        beePublicKey: resolved.beePublicKey,
        source: 'identity-feed',
        addedAt: Date.now(),
      })

      setContacts(next)
      setInvitations(prev => markInvitationProcessed(prev, selectedInvite.senderAddr))
      setSelectedId(selectedInvite.senderAddr) // switch into the new conversation
      setInviteNickname('')
    } catch (e) {
      setError((e as Error).message ?? 'Failed to add contact')
    } finally {
      setAcceptingInvite(false)
    }
  }

  // Inbox + invitation polling lives at the Layout level. We just re-read
  // localStorage on a short interval to pick up writes (new messages,
  // contacts added in another tab, on-chain invitations).
  useEffect(() => {
    const id = setInterval(() => {
      setThreads(loadThreads())
      setContacts(loadContacts())
      setInvitations(loadInvitations())
    }, 3_000)

    return () => clearInterval(id)
  }, [])

  // Auto-scroll to bottom on new messages or thread change
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [selectedId, selectedThread.length])

  // Mark read when a thread is open and gets new messages
  useEffect(() => {
    if (!selected) return
    const latestTs = selectedThread[selectedThread.length - 1]?.ts

    if (latestTs && latestTs > (cursors[selected.id.toLowerCase()] ?? 0)) {
      setCursors(prev => markRead(prev, selected.id, latestTs))
    }
  }, [selected, selectedThread, cursors])

  async function handleSend() {
    if (!signer || !selected || !draft.trim()) return

    if (!stampId) {
      setError('No usable stamp — buy one in Account → My Storage')

      return
    }
    setSending(true)
    setError(null)
    try {
      const myAddr = signer.getAddress()
      const body = draft.trim()

      await mailbox.send(
        bee,
        signer.getSigningKey(),
        stampId,
        signer.getSigningKey(),
        myAddr,
        toLibraryContact(selected),
        { subject: '', body },
      )
      setThreads(prev => appendSent(prev, selected.id, body))
      setDraft('')
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setSending(false)
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void handleSend()
    }
  }

  if (!walletConnected) {
    return (
      <div className="flex flex-col p-6 gap-4 max-w-3xl">
        <h2 className="text-2xl font-semibold">Messages</h2>
        <p className="text-sm" style={{ color: 'rgb(var(--fg-muted))' }}>
          Connect your wallet to see messages.
        </p>
      </div>
    )
  }

  if (!signer) {
    return (
      <div className="flex flex-col p-6 gap-4 max-w-3xl">
        <h2 className="text-2xl font-semibold">Messages</h2>
        <p className="text-sm" style={{ color: 'rgb(var(--fg-muted))' }}>
          Derive your Nook key to start messaging.
        </p>
        <button
          onClick={derive}
          className="self-start px-4 py-2 rounded text-xs font-semibold uppercase tracking-widest"
          style={{ backgroundColor: 'rgb(var(--accent))', color: '#fff' }}
        >
          Derive key
        </button>
      </div>
    )
  }

  if (contacts.length === 0 && pending.length === 0) {
    return (
      <div className="flex flex-col p-6 gap-4 max-w-3xl">
        <h2 className="text-2xl font-semibold">Messages</h2>
        <p className="text-sm" style={{ color: 'rgb(var(--fg-muted))' }}>
          You have no contacts yet. Add someone on the Contacts page first.
        </p>
      </div>
    )
  }

  return (
    <div className="flex h-full overflow-hidden">
      {/* Left pane — conversation list */}
      <div
        className="w-72 shrink-0 border-r flex flex-col"
        style={{ borderColor: 'rgb(var(--border))', backgroundColor: 'rgb(var(--bg-surface))' }}
      >
        <div
          className="px-4 py-3 border-b flex items-center justify-between"
          style={{ borderColor: 'rgb(var(--border))' }}
        >
          <h2 className="text-sm font-semibold uppercase tracking-widest" style={{ color: 'rgb(var(--fg-muted))' }}>
            Conversations
          </h2>
        </div>
        <div className="flex-1 overflow-auto">
          {/* Pending invitations — on-chain pings from senders not yet in contacts */}
          {pending.map(inv => {
            const isActive = inv.senderAddr === selectedId?.toLowerCase()

            return (
              <button
                key={inv.senderAddr}
                onClick={() => {
                  setSelectedId(inv.senderAddr)
                  setInviteNickname('')
                }}
                className="w-full text-left px-4 py-3 border-b flex flex-col gap-1 transition-colors"
                style={{
                  borderColor: 'rgb(var(--border))',
                  backgroundColor: isActive ? 'rgba(247,104,8,0.12)' : 'rgba(96,165,250,0.06)',
                }}
              >
                <div className="flex items-center gap-2">
                  <Mail size={12} style={{ color: '#60a5fa' }} />
                  <span className="font-medium text-sm truncate font-mono" style={{ color: 'rgb(var(--fg))' }}>
                    {short(inv.senderAddr, 8)}
                  </span>
                </div>
                <span className="text-xs truncate" style={{ color: 'rgb(var(--fg-muted))' }}>
                  Wants to reach you
                </span>
              </button>
            )
          })}
          {contacts.map(c => {
            const thread = threads[c.id.toLowerCase()]
            const unread = unreadCount(thread, cursors[c.id.toLowerCase()])
            const last = thread?.[thread.length - 1]
            const isActive = c.id === selectedId

            return (
              <button
                key={c.id}
                onClick={() => setSelectedId(c.id)}
                className="w-full text-left px-4 py-3 border-b flex flex-col gap-1 transition-colors"
                style={{
                  borderColor: 'rgb(var(--border))',
                  backgroundColor: isActive ? 'rgba(247,104,8,0.12)' : undefined,
                }}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium text-sm truncate" style={{ color: 'rgb(var(--fg))' }}>
                    {c.nickname}
                  </span>
                  {unread > 0 && (
                    <span
                      className="text-[10px] font-bold px-1.5 py-0.5 rounded-full shrink-0"
                      style={{ backgroundColor: 'rgb(var(--accent))', color: '#fff' }}
                    >
                      {unread}
                    </span>
                  )}
                </div>
                <span className="text-xs truncate" style={{ color: 'rgb(var(--fg-muted))' }}>
                  {last ? `${last.direction === 'sent' ? 'You: ' : ''}${last.body}` : short(c.id)}
                </span>
              </button>
            )
          })}
        </div>
      </div>

      {/* Right pane — selected thread + compose */}
      <div className="flex-1 flex flex-col min-w-0">
        {selected ? (
          <>
            <div className="px-6 py-3 border-b" style={{ borderColor: 'rgb(var(--border))' }}>
              <h2 className="text-base font-semibold" style={{ color: 'rgb(var(--fg))' }}>
                {selected.nickname}
              </h2>
              <p className="text-xs font-mono" style={{ color: 'rgb(var(--fg-muted))' }}>
                {short(selected.id, 8)}
              </p>
            </div>
            <div ref={scrollRef} className="flex-1 overflow-auto px-6 py-4 flex flex-col gap-3">
              {selectedThread.length === 0 ? (
                <p className="text-sm m-auto" style={{ color: 'rgb(var(--fg-muted))' }}>
                  No messages yet. Say hello.
                </p>
              ) : (
                selectedThread.map(m => {
                  if (m.kind === 'drive-share' && m.driveShareLink) {
                    const isSent = m.direction === 'sent'

                    return (
                      <div
                        key={m.id}
                        className={`max-w-[80%] rounded-2xl border px-4 py-3 space-y-2 ${isSent ? 'self-end' : 'self-start'}`}
                        style={{
                          backgroundColor: 'rgb(var(--bg-surface))',
                          borderColor: 'rgb(var(--accent))',
                          color: 'rgb(var(--fg))',
                        }}
                      >
                        <div className="flex items-center gap-2">
                          <FileText size={14} style={{ color: 'rgb(var(--accent))' }} />
                          <span className="text-xs uppercase tracking-widest" style={{ color: 'rgb(var(--accent))' }}>
                            {isSent ? 'Drive shared' : 'Drive shared with you'}
                          </span>
                        </div>
                        <div>
                          <p className="text-sm font-semibold">{m.driveName ?? 'Encrypted drive'}</p>
                          <p className="text-xs" style={{ color: 'rgb(var(--fg-muted))' }}>
                            {m.fileCount ?? 0} file{m.fileCount === 1 ? '' : 's'}
                          </p>
                        </div>
                        {!isSent && (
                          <button
                            onClick={() => setImportingLink(m.driveShareLink!)}
                            className="w-full py-1.5 rounded-lg text-xs font-semibold"
                            style={{ backgroundColor: 'rgb(var(--accent))', color: '#fff' }}
                          >
                            Add drive
                          </button>
                        )}
                        <p className="text-[10px]" style={{ color: 'rgb(var(--fg-muted))' }}>
                          {formatTime(m.ts)}
                        </p>
                      </div>
                    )
                  }

                  return (
                    <div
                      key={m.id}
                      className={`max-w-[70%] rounded-2xl px-4 py-2 ${m.direction === 'sent' ? 'self-end' : 'self-start'}`}
                      style={{
                        backgroundColor: m.direction === 'sent' ? 'rgb(var(--accent))' : 'rgb(var(--bg-surface))',
                        color: m.direction === 'sent' ? '#fff' : 'rgb(var(--fg))',
                      }}
                    >
                      <p className="text-sm whitespace-pre-wrap break-words">{m.body}</p>
                      <p
                        className="text-[10px] mt-1"
                        style={{ color: m.direction === 'sent' ? 'rgba(255,255,255,0.7)' : 'rgb(var(--fg-muted))' }}
                      >
                        {formatTime(m.ts)}
                      </p>
                    </div>
                  )
                })
              )}
            </div>
            <div className="border-t p-4" style={{ borderColor: 'rgb(var(--border))' }}>
              {error && (
                <p className="text-xs mb-2" style={{ color: '#ef4444' }}>
                  {error}
                </p>
              )}
              <div className="flex gap-2 items-end">
                <textarea
                  value={draft}
                  onChange={e => setDraft(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder={`Message ${selected.nickname}…`}
                  rows={1}
                  className="flex-1 rounded-lg border px-3 py-2 text-sm resize-none focus:outline-none"
                  style={{
                    backgroundColor: 'rgb(var(--bg))',
                    color: 'rgb(var(--fg))',
                    borderColor: 'rgb(var(--border))',
                    minHeight: 40,
                    maxHeight: 160,
                  }}
                />
                <button
                  onClick={handleSend}
                  disabled={sending || !draft.trim()}
                  className="rounded-lg p-2.5 transition-opacity disabled:opacity-40"
                  style={{ backgroundColor: 'rgb(var(--accent))', color: '#fff' }}
                  title="Send (Enter)"
                >
                  <Send size={16} />
                </button>
              </div>
            </div>
          </>
        ) : selectedInvite ? (
          <div className="flex-1 flex flex-col p-6 gap-4 max-w-xl">
            <div className="flex items-center gap-2">
              <Mail size={18} style={{ color: '#60a5fa' }} />
              <h2 className="text-base font-semibold" style={{ color: 'rgb(var(--fg))' }}>
                Someone wants to reach you
              </h2>
            </div>
            <div
              className="rounded-lg border p-4 space-y-2"
              style={{ backgroundColor: 'rgb(var(--bg-surface))', borderColor: 'rgb(var(--border))' }}
            >
              <p className="text-xs font-mono break-all" style={{ color: 'rgb(var(--fg-muted))' }}>
                {selectedInvite.senderAddr}
              </p>
              <p className="text-xs" style={{ color: 'rgb(var(--fg-muted))' }}>
                They sent you an on-chain wake-up at block {selectedInvite.blockNumber}. Add them as a contact to see
                any messages or drive shares they&apos;ve sent.
              </p>
            </div>
            <div className="space-y-2">
              <label className="text-xs uppercase tracking-widest" style={{ color: 'rgb(var(--fg-muted))' }}>
                Nickname
              </label>
              <input
                type="text"
                value={inviteNickname}
                onChange={e => setInviteNickname(e.target.value)}
                placeholder="e.g. Alice"
                className="w-full rounded-lg border px-3 py-2 text-sm focus:outline-none"
                style={{
                  backgroundColor: 'rgb(var(--bg))',
                  color: 'rgb(var(--fg))',
                  borderColor: 'rgb(var(--border))',
                }}
                autoFocus
              />
            </div>
            {error && (
              <p className="text-xs" style={{ color: '#ef4444' }}>
                {error}
              </p>
            )}
            <button
              onClick={handleAcceptInvite}
              disabled={acceptingInvite || !inviteNickname.trim()}
              className="self-start px-4 py-2 rounded-lg text-sm font-semibold disabled:opacity-40"
              style={{ backgroundColor: 'rgb(var(--accent))', color: '#fff' }}
            >
              {acceptingInvite ? 'Resolving & adding…' : 'Add as contact'}
            </button>
          </div>
        ) : (
          <div className="flex-1 flex items-center justify-center">
            <p className="text-sm" style={{ color: 'rgb(var(--fg-muted))' }}>
              Select a conversation
            </p>
          </div>
        )}
      </div>

      {importingLink && (
        <AddSharedDriveModal
          initialLink={importingLink}
          onClose={() => setImportingLink(null)}
          onAdd={drive => sharedDrives.add(drive)}
        />
      )}
    </div>
  )
}
