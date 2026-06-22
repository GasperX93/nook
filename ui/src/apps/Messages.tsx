import { Bee } from '@ethersphere/bee-js'
import { identity, mailbox, registry } from '@swarm-notify/sdk'
import { FileText, Mail, Send } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { getWalletClient, switchChain, waitForTransactionReceipt } from '@wagmi/core'
import { useWalletClient } from 'wagmi'

import { useAddresses, useStamps } from '../api/queries'
import AddSharedDriveModal from '../components/AddSharedDriveModal'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { Textarea } from '../components/ui/textarea'
import { useSharedDrives } from '../hooks/useSharedDrives'
import { useDerivedKey } from '../hooks/useDerivedKey'
import { hexToBytes } from '../lib/hex'
import { GNOSIS_CHAIN_ID, REGISTRY_ADDRESS } from '../notify/constants'
import {
  defaultInviteMessage,
  deriveConnectionState,
  getMyDisplayName,
  recordInviteSent,
  setMyDisplayName,
  type ConnectionState,
} from '../notify/contact-state'
import { sendInviteAck } from '../notify/invite-ack'
import { enqueueSend } from '../notify/send-queue'
import { loadInvitations, markInvitationProcessed, pendingInvitations, type Invitation } from '../notify/invitations'
import { appendSent, loadReadCursors, loadThreads, markRead, unreadCount } from '../notify/messages'
import { sendMailboxMessage } from '../notify/send-message'
import { waitForBeeReady } from '../notify/bee-ready'
import { createNotifyProvider } from '../notify/provider'
import { publishIdentity } from '../notify/publish-identity'
import { addContact, isIdentityPublished, loadContacts } from '../notify/storage'
import { toLibraryContact, type NookContact } from '../notify/types'
import { wagmiConfig } from '../wagmi'

const BEE_URL = `${window.location.origin}/bee-api`

function short(s: string, n = 6): string {
  return s.length <= n * 2 + 3 ? s : `${s.slice(0, n)}…${s.slice(-n)}`
}

// Turn a raw wallet/viem error into a one-line, user-facing message. Without
// this, the full viem dump (chain/from/to/data/Version) leaks into the UI.
function friendlyError(e: unknown): string {
  const raw = (e as Error)?.message ?? ''

  if (/user rejected|user denied|rejected the request|denied transaction/i.test(raw)) {
    return 'Invite cancelled — you declined the wallet prompt.'
  }

  if (/insufficient funds|exceeds the balance|gas required exceeds|cannot estimate gas/i.test(raw)) {
    return 'Not enough xDAI to send the on-chain invite. Top up in Account → Wallet.'
  }
  // viem BaseError exposes a clean one-liner; fall back to the first line.
  const short = (e as { shortMessage?: string })?.shortMessage

  if (typeof short === 'string' && short) return short

  return raw.split('\n')[0].slice(0, 200) || 'Something went wrong. Please try again.'
}

function formatTime(ts: number): string {
  const d = new Date(ts)
  const today = new Date()
  const sameDay = d.toDateString() === today.toDateString()

  return sameDay ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : d.toLocaleString()
}

interface MessagesProps {
  /** Optional contact ID to preselect (used when opening Messages scoped to a single contact). */
  initialContactId?: string
  /** When true, suppress the inner conversation list so only the thread + compose render. */
  hideContactList?: boolean
  /** When true, suppress the in-thread contact-name header. Useful when the parent renders its own. */
  hideThreadHeader?: boolean
}

export default function Messages({ initialContactId, hideContactList, hideThreadHeader }: MessagesProps = {}) {
  const { signer, derive, deriving, walletConnected } = useDerivedKey()
  const { data: stamps } = useStamps()
  const { data: addresses } = useAddresses()

  const bee = useMemo(() => new Bee(BEE_URL), [])
  // Re-read each render cycle so newly-added contacts (eg via accepting an
  // invitation) appear without a remount.
  const [contacts, setContacts] = useState<NookContact[]>(() => loadContacts())
  const [invitations, setInvitations] = useState<Invitation[]>(() => loadInvitations())

  const [threads, setThreads] = useState(() => loadThreads())
  const [cursors, setCursors] = useState(() => loadReadCursors())
  const [selectedId, setSelectedId] = useState<string | null>(initialContactId ?? contacts[0]?.id ?? null)
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Set when an invite is blocked because our identity isn't published yet —
  // drives an inline "Publish & send" so the user needn't leave for the Identity tab.
  const [needsPublish, setNeedsPublish] = useState(false)
  const [publishing, setPublishing] = useState(false)
  // Phase label shown while an invite is in flight — the publish + mailbox
  // writes happen before the wallet popup, so without this the gap looks stuck.
  const [sendStatus, setSendStatus] = useState<string | null>(null)
  // Pre-filled share link when the user clicks "Add drive" on a drive-share card
  const [importingLink, setImportingLink] = useState<string | null>(null)
  // Invitation acceptance state — nickname input + in-flight flag
  const [inviteNickname, setInviteNickname] = useState('')
  const [acceptingInvite, setAcceptingInvite] = useState(false)
  // Pre-acceptance peek: read sender's identity feed + mailbox so the
  // invitation panel can show context (sender name, their first message)
  // before the recipient commits to adding the contact.
  type InvitePreview = {
    loading: boolean
    firstSubject?: string
    firstBody?: string
    error?: string
  }
  const [invitePreview, setInvitePreview] = useState<InvitePreview>({ loading: false })
  const sharedDrives = useSharedDrives()
  const scrollRef = useRef<HTMLDivElement>(null)
  const { data: walletClient } = useWalletClient()

  // Sender's display name — used in the default invite template "X would
  // like to connect" and shown to the recipient when they receive the
  // invitation. Captured inline on first invite send, then reused.
  const [myDisplayName, setMyDisplayNameState] = useState<string>(() => getMyDisplayName())
  const [pendingNicknameInput, setPendingNicknameInput] = useState('')

  // Hide invitations from senders who are already contacts. Otherwise an old
  // invitation row pinned to the top of the list (created before the contact
  // was added) can shadow the actual conversation: clicking it shows the
  // "Add as contact" panel instead of the message thread, making it look like
  // no messages arrived. addContact never marks the invitation processed, so
  // the row would otherwise live forever.
  const pending = useMemo(() => {
    const known = new Set(contacts.map(c => c.id.toLowerCase()))

    return pendingInvitations(invitations).filter(i => !known.has(i.senderAddr))
  }, [invitations, contacts])

  const stampId = (stamps ?? []).find(s => s.usable)?.batchID ?? ''
  const selected = contacts.find(c => c.id === selectedId) ?? null
  const selectedThread = selected ? (threads[selected.id.toLowerCase()] ?? []) : []
  const hasInbound = selectedThread.some(m => m.direction === 'received')
  const connectionState: ConnectionState = selected ? deriveConnectionState(selected.id, hasInbound) : 'not-connected'
  const needsNickname = connectionState !== 'connected' && !myDisplayName
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

      const senderContact = {
        id: selectedInvite.senderAddr,
        nickname: inviteNickname.trim(),
        walletPublicKey: resolved.walletPublicKey,
        beePublicKey: resolved.beePublicKey,
        source: 'identity-feed' as const,
        addedAt: Date.now(),
      }
      const next = addContact(contacts, senderContact)

      setContacts(next)
      setInvitations(prev => markInvitationProcessed(prev, selectedInvite.senderAddr))
      setSelectedId(selectedInvite.senderAddr) // switch into the new conversation
      setInviteNickname('')

      // Tell the sender we accepted — flips their side from "waiting" to
      // "connected" (best-effort; no on-chain cost, we're mutual contacts now).
      if (signer) void sendInviteAck(bee, signer, stampId, senderContact, myDisplayName)
    } catch (e) {
      setError((e as Error).message ?? 'Failed to add contact')
    } finally {
      setAcceptingInvite(false)
    }
  }

  // When user selects a pending invitation, peek the sender's mailbox feed.
  // Read-only: no contact saved yet. Tries to extract a friendly name from
  // the message subject pattern emitted by ShareModal: "Name shared "X" with you".
  useEffect(() => {
    if (!selectedInvite || !signer) {
      setInvitePreview({ loading: false })

      return
    }
    let cancelled = false

    setInvitePreview({ loading: true })
    const myAddr = signer.getAddress()
    const senderAddr = selectedInvite.senderAddr

    ;(async () => {
      try {
        const resolved = await identity.resolve(bee, senderAddr)

        if (cancelled) return

        if (!resolved) {
          setInvitePreview({ loading: false, error: 'Sender identity not published.' })

          return
        }
        // Construct a temp Contact for the read — never persisted.
        const tempContact = {
          ethAddress: senderAddr,
          nickname: '',
          walletPublicKey: resolved.walletPublicKey,
          beePublicKey: resolved.beePublicKey,
          addedAt: Date.now(),
        }
        const messages = await mailbox.readMessages(bee, signer.getSigningKey(), myAddr, tempContact)

        if (cancelled) return
        const first = messages[messages.length - 1] ?? messages[0]

        // Security (D4): do NOT derive a display name from the sender-controlled
        // subject, and do NOT auto-fill the nickname from it. An arbitrary
        // on-chain address can set their subject to "YourBank shared …" and
        // spoof a trusted-looking identity before the user has accepted them.
        // The subject/body are shown below only as message *content*; the user
        // names the contact themselves.
        setInvitePreview({
          loading: false,
          firstSubject: first?.subject,
          firstBody: first?.body,
        })
      } catch (e) {
        if (cancelled) return
        setInvitePreview({ loading: false, error: (e as Error).message ?? 'Could not preview' })
      }
    })()

    return () => {
      cancelled = true
    }
  }, [selectedInvite, signer, bee])

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

  // Auto-scroll to bottom on selection / new messages. Defer with rAF so the
  // measurement happens after the new bubbles have laid out — without this,
  // scrollHeight can be stale on the first render after switching contacts
  // and the view ends up at the top of the thread.
  useEffect(() => {
    const el = scrollRef.current

    if (!el) return
    const id = requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight
    })

    return () => cancelAnimationFrame(id)
  }, [selectedId, selectedThread.length])

  // Mark read when a thread is open and gets new messages
  useEffect(() => {
    if (!selected) return
    const latestTs = selectedThread[selectedThread.length - 1]?.ts

    if (latestTs && latestTs > (cursors[selected.id.toLowerCase()] ?? 0)) {
      setCursors(prev => markRead(prev, selected.id, latestTs))
    }
  }, [selected, selectedThread, cursors])

  // Deliver a regular message in the background: serialize per recipient, hold
  // until the node is ready to push, and write to the next append-only feed
  // index via the persisted send cursor (so it can't overwrite a prior message).
  // NOTE: there's still no reliable sender-side delivery confirmation — sender
  // feed read-back diverges from what actually propagated — so we show no
  // sent/failed status. A truthful "delivered" needs recipient read receipts
  // (swarm-notify#56).
  async function deliverMessage(contact: NookContact, body: string) {
    const s = signer

    if (!s || !stampId) {
      if (!stampId) setError('No usable stamp — buy one in Account → My Storage')

      return
    }
    const stamp = stampId

    try {
      await enqueueSend(contact.id, async () => {
        // Don't send during warmup — a send before the node can push never
        // propagates to the recipient.
        if (!(await waitForBeeReady())) throw new Error('Node not ready yet')

        return sendMailboxMessage(bee, s.getSigningKey(), stamp, s.getAddress(), toLibraryContact(contact), {
          subject: '',
          body,
        })
      })
    } catch {
      setError('Message may not have sent — try again.')
    }
  }

  async function handleSend() {
    if (!signer || !selected) return

    // For 'connected' state we require a typed body. For invite states an
    // empty body falls back to the "<displayName> would like to connect" template.
    const isInviteState = connectionState !== 'connected'
    const trimmed = draft.trim()

    if (!isInviteState && !trimmed) return

    if (!stampId) {
      setError('No usable stamp — buy one in Account → My Storage')

      return
    }

    // Determine the display name for this invite. Persist it only AFTER the
    // invite fully succeeds (below). Persisting up front meant a failed/rejected
    // send still saved the name, making the name field vanish on the next try.
    let name = myDisplayName
    const nameIsNew = isInviteState && !name

    if (nameIsNew) {
      const candidate = pendingNicknameInput.trim()

      if (!candidate) {
        setError('Enter your name so the recipient knows who is reaching out.')

        return
      }
      name = candidate
    }

    const body = trimmed || (isInviteState && name ? defaultInviteMessage(name) : '')

    if (!body) return

    // ── Regular message (connected): optimistic + background confirmed delivery ──
    // Show the bubble instantly; deliverMessage sends in the background
    // (serialized per recipient, held until the node is ready).
    if (!isInviteState) {
      setError(null)
      setThreads(prev => appendSent(prev, selected.id, body))
      setDraft('')
      void deliverMessage(selected, body)

      return
    }

    // ── Invite: needs a connected wallet + published identity + on-chain ping ──
    if (!walletClient) {
      setError('Connect your wallet to send an invite (an on-chain ping is required).')

      return
    }

    // The recipient resolves us via our published identity feed to accept the
    // invite. If we haven't published, surface an inline "Publish & send".
    if (!isIdentityPublished(signer.getAddress())) {
      setNeedsPublish(true)
      setError('Publish your Nook identity so they can connect to you.')

      return
    }

    setSending(true)
    setError(null)
    setNeedsPublish(false)
    setSendStatus('Waiting for node…')
    try {
      const myAddr = signer.getAddress()

      await enqueueSend(selected.id, async () => {
        // Hold until the node can push — avoids a warmup-window send that
        // gets a local ✓ but never reaches the recipient.
        if (!(await waitForBeeReady())) throw new Error('Node not ready — try again in a moment.')
        setSendStatus('Sending invite…')

        return sendMailboxMessage(bee, signer.getSigningKey(), stampId, myAddr, toLibraryContact(selected), {
          subject: '',
          body,
        })
      })

      // Fire the on-chain wake-up so the recipient discovers this invite even
      // if they haven't added us yet. Switch to Gnosis just-in-time; re-fetch
      // the client after (stale across a chain change — same as ENSModal).
      setSendStatus('Confirm in your wallet…')

      if (walletClient.chain?.id !== GNOSIS_CHAIN_ID) {
        await switchChain(wagmiConfig, { chainId: GNOSIS_CHAIN_ID })
      }
      const gnosisClient = await getWalletClient(wagmiConfig, { chainId: GNOSIS_CHAIN_ID })
      const provider = createNotifyProvider(gnosisClient)
      const recipientPubKey = hexToBytes(selected.walletPublicKey)
      // Include our display name so the recipient's invitation shows who's
      // reaching out (payload is ECIES-encrypted to them — not public on-chain).
      const notifyTx = await registry.sendNotification(provider, REGISTRY_ADDRESS, recipientPubKey, selected.id, {
        sender: myAddr,
        name,
      } as Parameters<typeof registry.sendNotification>[4])
      setSendStatus('Confirming on-chain…')
      // sendNotification resolves on BROADCAST, not mining — wait for the
      // receipt so "sent" means it actually confirmed.
      const receipt = await waitForTransactionReceipt(wagmiConfig, {
        hash: notifyTx as `0x${string}`,
        chainId: GNOSIS_CHAIN_ID,
      })

      if (receipt.status !== 'success') {
        throw new Error(`On-chain invite failed to confirm (tx ${notifyTx}). The recipient was not notified.`)
      }
      recordInviteSent(selected.id)

      // Invite fully succeeded — lock in the display name for future invites.
      if (nameIsNew) {
        setMyDisplayName(name)
        setMyDisplayNameState(name)
        setPendingNicknameInput('')
      }

      setThreads(prev => appendSent(prev, selected.id, body))
      setDraft('')
    } catch (e) {
      setError(friendlyError(e))
    } finally {
      setSending(false)
      setSendStatus(null)
    }
  }

  // Inline recovery for the "publish your identity first" guard: publish, then
  // retry the send — no trip to the Identity tab.
  async function handlePublishAndSend() {
    if (!signer) return

    if (!addresses) {
      setError('Bee node not reachable — try again in a moment.')

      return
    }

    if (!stampId) {
      setError('No usable stamp — buy a drive in Account → My Storage to publish.')

      return
    }
    setPublishing(true)
    setError(null)
    setSendStatus('Publishing your identity…')
    try {
      await publishIdentity(bee, signer, stampId, addresses.publicKey)
      setNeedsPublish(false)
      await handleSend()
    } catch (e) {
      setError(friendlyError(e))
      setSendStatus(null)
    } finally {
      setPublishing(false)
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
          {deriving
            ? 'Check your wallet — approve the signature requests to finish setting up your Nook identity.'
            : 'Set up your Nook identity to start messaging.'}
        </p>
        <Button onClick={async () => derive()} disabled={deriving} className="self-start uppercase tracking-widest">
          {deriving ? 'Setting up…' : 'Set up Nook identity'}
        </Button>
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
      {/* Left pane — conversation list (hidden when Messages is embedded scoped to one contact) */}
      {!hideContactList && (
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
                    setInviteNickname(inv.senderName?.trim() ?? '')
                  }}
                  className="w-full text-left px-4 py-3 border-b flex flex-col gap-1 transition-colors"
                  style={{
                    borderColor: 'rgb(var(--border))',
                    backgroundColor: isActive ? 'rgba(247,104,8,0.12)' : 'rgba(96,165,250,0.06)',
                  }}
                >
                  <div className="flex items-center gap-2">
                    <Mail size={12} style={{ color: '#60a5fa' }} />
                    <span className="font-medium text-sm truncate" style={{ color: 'rgb(var(--fg))' }}>
                      {inv.senderName?.trim() || short(inv.senderAddr, 8)}
                    </span>
                  </div>
                  <span className="text-xs truncate font-mono" style={{ color: 'rgb(var(--fg-muted))' }}>
                    {inv.senderName?.trim() ? short(inv.senderAddr, 8) : 'Wants to reach you'}
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
                        style={{ backgroundColor: 'rgb(var(--accent))', color: 'rgb(var(--primary-foreground))' }}
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
      )}

      {/* Right pane — selected thread + compose */}
      <div className="flex-1 flex flex-col min-w-0">
        {selected ? (
          <>
            {!hideThreadHeader && (
              <div
                className="px-6 py-3 border-b flex items-center justify-between gap-3"
                style={{ borderColor: 'rgb(var(--border))' }}
              >
                <div>
                  <h2 className="text-base font-semibold" style={{ color: 'rgb(var(--fg))' }}>
                    {selected.nickname}
                  </h2>
                  <p className="text-xs font-mono" style={{ color: 'rgb(var(--fg-muted))' }}>
                    {short(selected.id, 8)}
                  </p>
                </div>
                <ConnectionStatusBadge state={connectionState} contactId={selected.id} />
              </div>
            )}
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
                          <Button onClick={() => setImportingLink(m.driveShareLink!)} size="sm" className="w-full">
                            Add drive
                          </Button>
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
                      className={`max-w-[70%] rounded-2xl px-4 py-2 ${
                        m.direction === 'sent' ? 'self-end bg-muted' : 'self-start bg-background border'
                      }`}
                    >
                      <p className="text-sm whitespace-pre-wrap break-words text-foreground">{m.body}</p>
                      <p className="text-[10px] mt-1 text-right text-muted-foreground">
                        {m.direction === 'sent' ? 'You' : selected.nickname} | {formatTime(m.ts)}
                      </p>
                    </div>
                  )
                })
              )}
            </div>
            <div className="border-t p-4 space-y-2" style={{ borderColor: 'rgb(var(--border))' }}>
              {error && (
                <p className="text-xs mb-2" style={{ color: needsPublish ? 'rgb(var(--fg-muted))' : '#ef4444' }}>
                  {error}
                </p>
              )}

              {needsPublish && (
                <Button onClick={handlePublishAndSend} disabled={publishing} size="sm" className="mb-2">
                  {publishing ? 'Publishing…' : 'Publish identity & send'}
                </Button>
              )}

              {sendStatus && (
                <p
                  className="text-xs mb-2 flex items-center gap-1.5 animate-pulse"
                  style={{ color: 'rgb(var(--accent))' }}
                >
                  <Send size={12} />
                  {sendStatus}
                </p>
              )}

              {needsNickname && (
                <div
                  className="rounded-lg border p-3 space-y-2"
                  style={{ backgroundColor: 'rgb(var(--bg-surface))', borderColor: 'rgb(var(--border))' }}
                >
                  <p className="text-xs" style={{ color: 'rgb(var(--fg-muted))' }}>
                    What should they call you? Shown to the recipient in your invite.
                  </p>
                  <Input
                    autoFocus
                    value={pendingNicknameInput}
                    onChange={e => setPendingNicknameInput(e.target.value)}
                    placeholder="Your name"
                  />
                </div>
              )}

              <div className="flex gap-2 items-end">
                <Textarea
                  value={draft}
                  onChange={e => setDraft(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder={
                    connectionState === 'connected'
                      ? `Message ${selected.nickname}…`
                      : myDisplayName
                        ? `Optional — defaults to "${myDisplayName} would like to connect"`
                        : `Optional message — your name will be added`
                  }
                  rows={1}
                  className="flex-1 resize-none"
                  style={{ minHeight: 40, maxHeight: 160 }}
                />
                <Button
                  onClick={handleSend}
                  disabled={
                    sending ||
                    (needsNickname && !pendingNicknameInput.trim()) ||
                    (connectionState === 'connected' && !draft.trim())
                  }
                  size={connectionState === 'connected' ? 'icon' : 'sm'}
                  title={
                    connectionState === 'connected'
                      ? 'Send (Enter)'
                      : connectionState === 'not-connected'
                        ? 'Send invite'
                        : 'Resend invite'
                  }
                  className={connectionState === 'connected' ? '' : 'whitespace-nowrap'}
                >
                  {connectionState === 'connected' ? (
                    <Send size={16} />
                  ) : connectionState === 'not-connected' ? (
                    'Send invite'
                  ) : (
                    'Resend invite'
                  )}
                </Button>
              </div>
            </div>
          </>
        ) : selectedInvite ? (
          <div className="flex-1 flex flex-col p-6 gap-4 max-w-xl">
            <div className="flex items-center gap-2">
              <Mail size={18} style={{ color: '#60a5fa' }} />
              <h2 className="text-base font-semibold" style={{ color: 'rgb(var(--fg))' }}>
                {selectedInvite.senderName?.trim()
                  ? `${selectedInvite.senderName.trim()} wants to connect`
                  : 'Someone wants to reach you'}
              </h2>
            </div>
            <div
              className="rounded-lg border p-4 space-y-2"
              style={{ backgroundColor: 'rgb(var(--bg-surface))', borderColor: 'rgb(var(--border))' }}
            >
              <p className="text-xs font-mono break-all" style={{ color: 'rgb(var(--fg-muted))' }}>
                {selectedInvite.senderAddr}
              </p>
              {invitePreview.loading && (
                <p className="text-xs" style={{ color: 'rgb(var(--fg-muted))' }}>
                  Reading sender&apos;s mailbox feed…
                </p>
              )}
              {invitePreview.firstSubject && (
                <div className="rounded border-l-2 pl-3 py-1 mt-2" style={{ borderColor: 'rgb(var(--accent))' }}>
                  <p className="text-sm font-medium" style={{ color: 'rgb(var(--fg))' }}>
                    {invitePreview.firstSubject}
                  </p>
                  {invitePreview.firstBody && (
                    <p className="text-xs mt-1" style={{ color: 'rgb(var(--fg-muted))' }}>
                      {invitePreview.firstBody}
                    </p>
                  )}
                </div>
              )}
              {invitePreview.error && (
                <p className="text-xs" style={{ color: 'rgb(var(--fg-muted))' }}>
                  Couldn&apos;t peek the sender&apos;s feed yet ({invitePreview.error}). Add them as a contact to see
                  the message.
                </p>
              )}
              {!invitePreview.loading && !invitePreview.firstSubject && !invitePreview.error && (
                <p className="text-xs" style={{ color: 'rgb(var(--fg-muted))' }}>
                  They sent you an on-chain wake-up at block {selectedInvite.blockNumber}. Add them as a contact to see
                  any messages or drive shares they&apos;ve sent.
                </p>
              )}
            </div>
            <div className="space-y-2">
              <label className="text-xs uppercase tracking-widest" style={{ color: 'rgb(var(--fg-muted))' }}>
                Nickname
              </label>
              <Input
                value={inviteNickname}
                onChange={e => setInviteNickname(e.target.value)}
                placeholder="e.g. Alice"
                autoFocus
              />
            </div>
            {error && (
              <p className="text-xs" style={{ color: '#ef4444' }}>
                {error}
              </p>
            )}
            <Button
              onClick={handleAcceptInvite}
              disabled={acceptingInvite || !inviteNickname.trim()}
              className="self-start"
            >
              {acceptingInvite ? 'Resolving & adding…' : 'Add as contact'}
            </Button>
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

export function ConnectionStatusBadge({ state, contactId }: { state: ConnectionState; contactId: string }) {
  // For invite-sent states, show how long ago we sent it.
  const sentAt = state === 'invite-sent-fresh' || state === 'invite-sent-stale' ? getInviteSentAtMs(contactId) : null
  const hint = sentAt ? formatAge(sentAt) : null

  const style: Record<ConnectionState, { label: string; bg: string; fg: string; dot: string }> = {
    'not-connected': {
      label: 'Not yet connected',
      bg: 'rgba(255,255,255,0.06)',
      fg: 'rgb(var(--fg-muted))',
      dot: 'rgb(var(--fg-muted))',
    },
    'invite-sent-fresh': {
      label: hint ? `Invite sent ${hint} ago` : 'Invite sent — waiting',
      bg: 'rgba(247,104,8,0.10)',
      fg: 'rgb(var(--accent))',
      dot: 'rgb(var(--accent))',
    },
    'invite-sent-stale': {
      label: hint ? `Sent ${hint} ago — you can resend` : 'Older invite — you can resend',
      bg: 'rgba(247,104,8,0.10)',
      fg: 'rgb(var(--accent))',
      dot: 'rgb(var(--accent))',
    },
    connected: {
      label: 'Connected',
      bg: 'rgba(34,197,94,0.12)',
      fg: 'rgb(74,222,128)',
      dot: 'rgb(34,197,94)',
    },
  }
  const s = style[state]

  return (
    <span
      className="inline-flex items-center gap-1.5 text-[10px] uppercase tracking-widest px-2 py-1 rounded shrink-0"
      style={{ backgroundColor: s.bg, color: s.fg }}
    >
      <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: s.dot }} />
      {s.label}
    </span>
  )
}

function getInviteSentAtMs(contactId: string): number | null {
  // Re-read each render — cheap localStorage lookup, keeps badge fresh after Send invite.
  try {
    const raw = localStorage.getItem('nook-invitations-sent-v1')

    if (!raw) return null
    const map = JSON.parse(raw) as Record<string, { sentAt: number }>

    return map[contactId.toLowerCase()]?.sentAt ?? null
  } catch {
    return null
  }
}

function formatAge(sentAtMs: number): string {
  const diff = Date.now() - sentAtMs
  const minutes = Math.floor(diff / 60_000)

  if (minutes < 1) return 'just now'

  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)

  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)

  return `${days}d`
}
