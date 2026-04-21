import { Bee } from '@ethersphere/bee-js'
import { ContactStore, identity, mailbox, registry } from '@swarm-notify/sdk'
import { useEffect, useMemo, useState } from 'react'
import { useWalletClient } from 'wagmi'

import { useAddresses, useStamps } from '../api/queries'
import { useDerivedKey } from '../hooks/useDerivedKey'
import { GNOSIS_CHAIN_ID, REGISTRY_ADDRESS } from '../notify/constants'
import { createNotifyProvider } from '../notify/provider'

// Vite proxies /bee-api → http://localhost:1633 in dev. This dev panel only ships in dev mode,
// so the prod Koa server doesn't need to proxy /bee-api (would 404 there).
const BEE_URL = `${window.location.origin}/bee-api`

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex

  return new Uint8Array(clean.match(/.{2}/g)!.map(byte => parseInt(byte, 16)))
}

function short(s: string, n = 10): string {
  return s.length <= n * 2 + 3 ? s : `${s.slice(0, n)}…${s.slice(-n)}`
}

export function SwarmNotifyTest() {
  const { signer, derive, walletConnected } = useDerivedKey()
  const { data: walletClient } = useWalletClient()
  const { data: addresses } = useAddresses()
  const { data: stamps } = useStamps()

  const bee = useMemo(() => new Bee(BEE_URL), [])
  const [contactStore] = useState(() => new ContactStore())
  const [, setContactsTick] = useState(0)
  const refreshContacts = () => setContactsTick(t => t + 1)

  const [stampId, setStampId] = useState('')
  const [resolveAddr, setResolveAddr] = useState('')
  const [contactAddr, setContactAddr] = useState('')
  const [contactNickname, setContactNickname] = useState('')
  const [sendTo, setSendTo] = useState('')
  const [sendSubject, setSendSubject] = useState('')
  const [sendBody, setSendBody] = useState('')
  const [pollFromBlock, setPollFromBlock] = useState('')

  const [log, setLog] = useState<string[]>([])

  function addLog(msg: string) {
    setLog(prev => [...prev, `[${new Date().toLocaleTimeString()}] ${msg}`])
  }

  const usableStamps = (stamps ?? []).filter(s => s.usable)
  const contacts = contactStore.list()

  useEffect(() => {
    if (!stampId && usableStamps.length > 0) {
      setStampId(usableStamps[0].batchID)
    }
  }, [usableStamps, stampId])

  async function handlePublishIdentity() {
    if (!signer) return addLog('No signer — derive wallet key first')

    if (!addresses) return addLog('Bee addresses not loaded')

    if (!stampId) return addLog('No usable stamp')

    try {
      addLog('Publishing identity…')
      await identity.publish(bee, signer.getSigningKey(), stampId, {
        walletPublicKey: bytesToHex(signer.getPublicKey()),
        beePublicKey: addresses.publicKey,
        overlay: addresses.overlay,
        ethAddress: signer.getAddress(),
      })
      addLog(`Identity published for ${signer.getAddress()}`)
    } catch (e) {
      addLog(`Publish failed: ${(e as Error).message}`)
    }
  }

  async function handleResolve() {
    if (!resolveAddr) return addLog('Enter an ETH address')

    try {
      addLog(`Resolving ${resolveAddr}…`)
      const result = await identity.resolve(bee, resolveAddr)

      if (!result) {
        addLog(`No identity found for ${resolveAddr}`)
      } else {
        addLog(`Resolved: overlay=${short(result.overlay)} walletPubKey=${short(result.walletPublicKey)}`)
      }
    } catch (e) {
      addLog(`Resolve failed: ${(e as Error).message}`)
    }
  }

  async function handleAddContact() {
    if (!contactAddr || !contactNickname) return addLog('Need ETH address and nickname')

    try {
      addLog(`Resolving ${contactAddr}…`)
      const result = await identity.resolve(bee, contactAddr)

      if (!result) {
        addLog(`No identity for ${contactAddr} — they must publish first`)

        return
      }
      const contact = contactStore.add(contactAddr, contactNickname, result)
      refreshContacts()
      addLog(`Added contact ${contact.nickname} (${short(contact.ethAddress)})`)
      setContactAddr('')
      setContactNickname('')
    } catch (e) {
      addLog(`Add contact failed: ${(e as Error).message}`)
    }
  }

  function handleRemoveContact(addr: string) {
    contactStore.remove(addr)
    refreshContacts()
    addLog(`Removed ${short(addr)}`)
  }

  async function handleSend() {
    if (!signer) return addLog('No signer')

    if (!addresses) return addLog('Bee addresses not loaded')

    if (!stampId) return addLog('No usable stamp')

    const recipient = contacts.find(c => c.ethAddress.toLowerCase() === sendTo.toLowerCase())

    if (!recipient) return addLog(`Recipient not in contacts: ${sendTo}`)

    try {
      addLog(`Sending to ${recipient.nickname}…`)
      await mailbox.send(bee, signer.getSigningKey(), stampId, signer.getSigningKey(), addresses.overlay, recipient, {
        subject: sendSubject,
        body: sendBody,
      })
      addLog(`Sent to ${recipient.nickname}`)
    } catch (e) {
      addLog(`Send failed: ${(e as Error).message}`)
    }
  }

  async function handleCheckInbox() {
    if (!signer) return addLog('No signer')

    if (!addresses) return addLog('Bee addresses not loaded')

    try {
      addLog(`Checking inbox across ${contacts.length} contact(s)…`)
      const inbox = await mailbox.checkInbox(bee, signer.getSigningKey(), addresses.overlay, contacts)

      if (inbox.length === 0) {
        addLog('No messages')
      } else {
        inbox.forEach(({ contact, messages }) => {
          addLog(`${contact.nickname}: ${messages.length} message(s)`)
          messages.forEach(m => addLog(`  ${m.subject} — ${m.body}`))
        })
      }
    } catch (e) {
      addLog(`Inbox check failed: ${(e as Error).message}`)
    }
  }

  async function handleSendNotification() {
    if (!signer) return addLog('No signer')

    if (!walletClient) return addLog('Connect wallet to send Gnosis tx')

    if (walletClient.chain?.id !== GNOSIS_CHAIN_ID) {
      return addLog(`Wallet on chain ${walletClient.chain?.id}, switch to Gnosis (${GNOSIS_CHAIN_ID})`)
    }

    if (!addresses) return addLog('Bee addresses not loaded')

    const recipient = contacts.find(c => c.ethAddress.toLowerCase() === sendTo.toLowerCase())

    if (!recipient) return addLog(`Recipient not in contacts: ${sendTo}`)

    try {
      const provider = createNotifyProvider(walletClient)
      const feedTopic = mailbox.feedTopic(addresses.overlay, recipient.overlay)
      const recipientPubKey = hexToBytes(recipient.walletPublicKey)

      addLog(`Sending notification to ${recipient.nickname}…`)
      const txHash = await registry.sendNotification(
        provider,
        REGISTRY_ADDRESS,
        recipientPubKey,
        recipient.ethAddress,
        {
          sender: signer.getAddress(),
          overlay: addresses.overlay,
          feedTopic,
        },
      )
      addLog(`Notification tx: ${short(txHash, 16)}`)
    } catch (e) {
      addLog(`Notification failed: ${(e as Error).message}`)
    }
  }

  async function handlePoll() {
    if (!signer) return addLog('No signer')

    try {
      const provider = createNotifyProvider()
      const fromBlock = pollFromBlock ? parseInt(pollFromBlock, 10) : 0

      addLog(`Polling notifications from block ${fromBlock}…`)
      const notifications = await registry.pollNotifications(
        provider,
        REGISTRY_ADDRESS,
        signer.getAddress(),
        signer.getSigningKey(),
        fromBlock,
      )

      if (notifications.length === 0) {
        addLog('No notifications')
      } else {
        notifications.forEach(n => {
          addLog(`  block ${n.blockNumber}: from ${short(n.payload.sender)} feed ${short(n.payload.feedTopic)}`)
        })
      }
    } catch (e) {
      addLog(`Poll failed: ${(e as Error).message}`)
    }
  }

  const btnClass =
    'px-3 py-1.5 rounded text-xs font-semibold uppercase tracking-widest transition-opacity disabled:opacity-40'
  const btnStyle = { backgroundColor: 'rgb(var(--bg))', border: '1px solid rgb(var(--border))' }
  const accentStyle = { backgroundColor: 'rgb(var(--accent))', color: '#fff' }
  const inputClass = 'rounded border px-2 py-1 text-xs font-mono focus:outline-none w-full'
  const inputStyle = {
    backgroundColor: 'rgb(var(--bg))',
    color: 'rgb(var(--fg))',
    borderColor: 'rgb(var(--border))',
  }

  return (
    <div className="rounded-xl border p-5 space-y-4 shrink-0" style={{ backgroundColor: 'rgb(var(--bg-surface))' }}>
      <div>
        <p className="text-xs uppercase tracking-widest mb-1" style={{ color: 'rgb(var(--fg-muted))' }}>
          Swarm Notify
        </p>
        <p className="text-sm mb-3">
          End-to-end smoke test for the swarm-notify library — identity feeds, mailbox, on-chain registry.
        </p>
      </div>

      <div className="text-xs space-y-1" style={{ color: 'rgb(var(--fg-muted))' }}>
        <div>
          Nook address:{' '}
          {signer ? (
            <span style={{ color: 'rgb(var(--fg))' }}>
              {signer.getAddress()} · pubKey {short(bytesToHex(signer.getPublicKey()))}
            </span>
          ) : walletConnected ? (
            <button onClick={derive} className="underline">
              derive key
            </button>
          ) : (
            'connect wallet to derive Nook address'
          )}
        </div>
        <div>
          Bee: {addresses ? <span style={{ color: 'rgb(var(--fg))' }}>overlay {short(addresses.overlay)}</span> : '—'}
        </div>
        <div>
          Stamp:{' '}
          {usableStamps.length > 0 ? (
            <select
              value={stampId}
              onChange={e => setStampId(e.target.value)}
              className="rounded border px-2 py-0.5 text-xs"
              style={inputStyle}
            >
              {usableStamps.map(s => (
                <option key={s.batchID} value={s.batchID}>
                  {s.label || short(s.batchID)} (depth {s.depth})
                </option>
              ))}
            </select>
          ) : (
            'no usable stamp — buy one in Account → My Storage'
          )}
        </div>
        <div>
          Wallet chain:{' '}
          {walletClient?.chain ? (
            <span style={{ color: walletClient.chain.id === GNOSIS_CHAIN_ID ? 'rgb(var(--fg))' : 'rgb(255,140,40)' }}>
              {walletClient.chain.name} ({walletClient.chain.id})
              {walletClient.chain.id !== GNOSIS_CHAIN_ID && ' — switch to Gnosis for sendNotification'}
            </span>
          ) : (
            '—'
          )}
        </div>
      </div>

      <div className="border-t pt-3" style={{ borderColor: 'rgb(var(--border))' }}>
        <button onClick={handlePublishIdentity} className={btnClass} style={accentStyle}>
          Publish my identity
        </button>
      </div>

      <div className="border-t pt-3 space-y-2" style={{ borderColor: 'rgb(var(--border))' }}>
        <input
          className={inputClass}
          style={inputStyle}
          placeholder="Nook address to resolve"
          value={resolveAddr}
          onChange={e => setResolveAddr(e.target.value)}
        />
        <button onClick={handleResolve} className={btnClass} style={btnStyle}>
          Resolve identity
        </button>
      </div>

      <div className="border-t pt-3 space-y-2" style={{ borderColor: 'rgb(var(--border))' }}>
        <div className="grid grid-cols-2 gap-2">
          <input
            className={inputClass}
            style={inputStyle}
            placeholder="Nook address"
            value={contactAddr}
            onChange={e => setContactAddr(e.target.value)}
          />
          <input
            className={inputClass}
            style={inputStyle}
            placeholder="Nickname"
            value={contactNickname}
            onChange={e => setContactNickname(e.target.value)}
          />
        </div>
        <button onClick={handleAddContact} className={btnClass} style={btnStyle}>
          Add contact
        </button>
        {contacts.length > 0 && (
          <div className="text-xs space-y-1 pt-2">
            {contacts.map(c => (
              <div key={c.ethAddress} className="flex items-center justify-between">
                <span style={{ color: 'rgb(var(--fg))' }}>
                  {c.nickname} <span style={{ color: 'rgb(var(--fg-muted))' }}>{short(c.ethAddress)}</span>
                </span>
                <button onClick={() => handleRemoveContact(c.ethAddress)} className="text-xs underline">
                  remove
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="border-t pt-3 space-y-2" style={{ borderColor: 'rgb(var(--border))' }}>
        <input
          className={inputClass}
          style={inputStyle}
          placeholder="Recipient Nook address (must be in contacts)"
          value={sendTo}
          onChange={e => setSendTo(e.target.value)}
        />
        <input
          className={inputClass}
          style={inputStyle}
          placeholder="Subject"
          value={sendSubject}
          onChange={e => setSendSubject(e.target.value)}
        />
        <textarea
          className={`${inputClass} h-20 resize-none`}
          style={inputStyle}
          placeholder="Body"
          value={sendBody}
          onChange={e => setSendBody(e.target.value)}
        />
        <div className="flex gap-2">
          <button onClick={handleSend} className={btnClass} style={btnStyle}>
            Send message
          </button>
          <button onClick={handleSendNotification} className={btnClass} style={btnStyle}>
            Send on-chain notification
          </button>
        </div>
      </div>

      <div className="border-t pt-3 space-y-2" style={{ borderColor: 'rgb(var(--border))' }}>
        <div className="flex gap-2">
          <button onClick={handleCheckInbox} className={btnClass} style={btnStyle}>
            Check inbox
          </button>
          <input
            className={inputClass}
            style={{ ...inputStyle, maxWidth: 160 }}
            placeholder="from block (optional)"
            value={pollFromBlock}
            onChange={e => setPollFromBlock(e.target.value)}
          />
          <button onClick={handlePoll} className={btnClass} style={btnStyle}>
            Poll notifications
          </button>
        </div>
      </div>

      {log.length > 0 && (
        <div
          className="border-t pt-3 text-xs font-mono space-y-0.5 max-h-64 overflow-auto"
          style={{ borderColor: 'rgb(var(--border))', color: 'rgb(var(--fg-muted))' }}
        >
          {log.map((line, i) => (
            <div key={i}>{line}</div>
          ))}
        </div>
      )}
    </div>
  )
}
