import { Bee } from '@ethersphere/bee-js'
import { mailbox } from '@swarm-notify/sdk'
import { FileText, Send } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'

import { useStamps } from '../api/queries'
import AddSharedDriveModal from '../components/AddSharedDriveModal'
import { useSharedDrives } from '../hooks/useSharedDrives'
import { useDerivedKey } from '../hooks/useDerivedKey'
import { appendSent, loadReadCursors, loadThreads, markRead, mergeReceived, unreadCount } from '../notify/messages'
import { loadContacts } from '../notify/storage'
import { toLibraryContact, type NookContact } from '../notify/types'

const BEE_URL = `${window.location.origin}/bee-api`
const POLL_INTERVAL_MS = 30_000

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
  const contacts = useMemo<NookContact[]>(() => loadContacts(), [])

  const [threads, setThreads] = useState(() => loadThreads())
  const [cursors, setCursors] = useState(() => loadReadCursors())
  const [selectedId, setSelectedId] = useState<string | null>(contacts[0]?.id ?? null)
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [polling, setPolling] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Pre-filled share link when the user clicks "Add drive" on a drive-share card
  const [importingLink, setImportingLink] = useState<string | null>(null)
  const sharedDrives = useSharedDrives()
  const scrollRef = useRef<HTMLDivElement>(null)

  const stampId = (stamps ?? []).find(s => s.usable)?.batchID ?? ''
  const selected = contacts.find(c => c.id === selectedId) ?? null
  const selectedThread = selected ? (threads[selected.id.toLowerCase()] ?? []) : []

  const checkInbox = useMemo(
    () => async () => {
      if (!signer || contacts.length === 0) return
      setPolling(true)
      setError(null)
      try {
        const myAddr = signer.getAddress()
        const inbox = await mailbox.checkInbox(bee, signer.getSigningKey(), myAddr, contacts.map(toLibraryContact))

        setThreads(prev => {
          let next = prev

          for (const { contact, messages } of inbox) {
            next = mergeReceived(next, contact.ethAddress, messages)
          }

          return next
        })
      } catch (e) {
        setError((e as Error).message)
      } finally {
        setPolling(false)
      }
    },
    [bee, contacts, signer],
  )

  // Initial fetch + polling loop
  useEffect(() => {
    if (!signer) return
    void checkInbox()
    const id = setInterval(() => void checkInbox(), POLL_INTERVAL_MS)

    return () => clearInterval(id)
  }, [signer, checkInbox])

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

  if (contacts.length === 0) {
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
          {polling && (
            <span className="text-[10px]" style={{ color: 'rgb(var(--fg-muted))' }}>
              syncing…
            </span>
          )}
        </div>
        <div className="flex-1 overflow-auto">
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
