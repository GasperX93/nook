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

/** Full-length for debugging, short for display labels */
function full(s: string): string {
  return s
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
    if (!signer) return addLog('ERROR: No signer — derive wallet key first')

    if (!addresses) return addLog('ERROR: Bee addresses not loaded')

    if (!stampId) return addLog('ERROR: No usable stamp')

    const ethAddr = signer.getAddress()
    const walletPubKey = bytesToHex(signer.getPublicKey())
    const topic = identity.feedTopic(ethAddr)

    try {
      addLog('Publishing identity…')
      addLog(`  signer address: ${full(ethAddr)}`)
      addLog(`  wallet pubkey: ${full(walletPubKey)}`)
      addLog(`  bee pubkey: ${full(addresses.publicKey)}`)
      addLog(`  stamp: ${full(stampId)}`)
      addLog(`  feed topic: ${full(topic)}`)
      await identity.publish(bee, signer.getSigningKey(), stampId, {
        walletPublicKey: walletPubKey,
        beePublicKey: addresses.publicKey,
        ethAddress: ethAddr,
      })
      addLog(`  feed write: OK`)

      // Verify: read it back
      addLog(`  verify: re-resolving own identity…`)
      const readback = await identity.resolve(bee, ethAddr)

      if (readback) {
        addLog(
          `  verify: OK — walletPubKey=${full(readback.walletPublicKey)}, beePubKey=${full(readback.beePublicKey)}`,
        )
      } else {
        addLog(`  verify: FAILED — identity not readable after publish`)
      }
      addLog(`Identity published for ${full(ethAddr)}`)
    } catch (e) {
      addLog(`Publish FAILED: ${(e as Error).message}`)
      addLog(`  stack: ${(e as Error).stack?.split('\n').slice(0, 3).join(' | ')}`)
    }
  }

  async function handleResolve() {
    if (!resolveAddr) return addLog('ERROR: Enter an ETH address')

    const topic = identity.feedTopic(resolveAddr)

    try {
      addLog(`Resolving ${full(resolveAddr)}…`)
      addLog(`  feed topic: ${full(topic)}`)
      addLog(`  feed owner (derived from address): ${full(resolveAddr)}`)
      const result = await identity.resolve(bee, resolveAddr)

      if (!result) {
        addLog(`  result: feed not found or empty`)
        addLog(`  → this user may not have published their identity yet`)
        addLog(`No identity found for ${full(resolveAddr)}`)
      } else {
        addLog(`  walletPubKey: ${full(result.walletPublicKey)}`)
        addLog(`  beePubKey: ${full(result.beePublicKey)}`)
        addLog(`  ethAddress: ${full(result.ethAddress ?? 'not set')}`)
        addLog(`Resolved ${full(resolveAddr)}`)
      }
    } catch (e) {
      addLog(`Resolve FAILED: ${(e as Error).message}`)
      addLog(`  stack: ${(e as Error).stack?.split('\n').slice(0, 3).join(' | ')}`)
    }
  }

  async function handleAddContact() {
    if (!contactAddr || !contactNickname) return addLog('ERROR: Need ETH address and nickname')

    try {
      addLog(`Adding contact: resolving ${full(contactAddr)}…`)
      const result = await identity.resolve(bee, contactAddr)

      if (!result) {
        addLog(`  identity not found — they must publish first`)
        addLog(`  feed topic checked: ${full(identity.feedTopic(contactAddr))}`)

        return
      }
      addLog(`  resolved: walletPubKey=${full(result.walletPublicKey)}`)
      addLog(`  beePubKey: ${full(result.beePublicKey)}`)
      const contact = contactStore.add(contactAddr, contactNickname, result)
      refreshContacts()
      addLog(`Added contact ${contact.nickname} (${full(contact.ethAddress)})`)
      setContactAddr('')
      setContactNickname('')
    } catch (e) {
      addLog(`Add contact FAILED: ${(e as Error).message}`)
    }
  }

  function handleRemoveContact(addr: string) {
    contactStore.remove(addr)
    refreshContacts()
    addLog(`Removed ${short(addr)}`)
  }

  async function handleSend() {
    if (!signer) return addLog('ERROR: No signer')

    if (!addresses) return addLog('ERROR: Bee addresses not loaded')

    if (!stampId) return addLog('ERROR: No usable stamp')

    const recipient = contacts.find(c => c.ethAddress.toLowerCase() === sendTo.toLowerCase())

    if (!recipient) return addLog(`ERROR: Recipient not in contacts: ${full(sendTo)}`)

    const myAddr = signer.getAddress()
    const topic = mailbox.feedTopic(myAddr, recipient.ethAddress)

    try {
      addLog(`Sending to ${recipient.nickname}…`)
      addLog(`  my address: ${full(myAddr)}`)
      addLog(`  recipient address: ${full(recipient.ethAddress)}`)
      addLog(`  feed topic: ${full(topic)}`)
      addLog(`  stamp: ${full(stampId)}`)
      addLog(`  subject: ${sendSubject}`)
      addLog(`  body length: ${sendBody.length} chars`)
      const t0 = Date.now()
      await mailbox.send(bee, signer.getSigningKey(), stampId, signer.getSigningKey(), myAddr, recipient, {
        subject: sendSubject,
        body: sendBody,
      })
      addLog(`  duration: ${Date.now() - t0}ms`)
      addLog(`Sent to ${recipient.nickname}`)
    } catch (e) {
      addLog(`Send FAILED: ${(e as Error).message}`)
      addLog(`  stack: ${(e as Error).stack?.split('\n').slice(0, 3).join(' | ')}`)
    }
  }

  async function handleCheckInbox() {
    if (!signer) return addLog('ERROR: No signer')

    if (!addresses) return addLog('ERROR: Bee addresses not loaded')

    try {
      const myAddr = signer.getAddress()

      addLog(`Checking inbox across ${contacts.length} contact(s)…`)
      addLog(`  my address: ${full(myAddr)}`)

      for (const c of contacts) {
        const topic = mailbox.feedTopic(c.ethAddress, myAddr)

        addLog(`  ${c.nickname}: feed topic=${full(topic)}, feed owner=${full(c.ethAddress)}`)
      }

      const t0 = Date.now()
      const inbox = await mailbox.checkInbox(bee, signer.getSigningKey(), myAddr, contacts)

      addLog(`  duration: ${Date.now() - t0}ms`)

      if (inbox.length === 0) {
        addLog('No messages')

        if (contacts.length > 0) {
          addLog(`  → checked ${contacts.length} contact feed(s), all empty or not found`)
          addLog(`  → make sure the sender used YOUR Nook address in their feed topic`)
        }
      } else {
        inbox.forEach(({ contact, messages }) => {
          addLog(`${contact.nickname}: ${messages.length} message(s)`)
          messages.forEach(m => addLog(`  [${new Date(m.ts).toLocaleString()}] ${m.subject} — ${m.body}`))
        })
      }
    } catch (e) {
      addLog(`Inbox check FAILED: ${(e as Error).message}`)
      addLog(`  stack: ${(e as Error).stack?.split('\n').slice(0, 3).join(' | ')}`)
    }
  }

  async function handleSendNotification() {
    if (!signer) return addLog('ERROR: No signer')

    if (!walletClient) return addLog('ERROR: Connect wallet to send Gnosis tx')

    if (walletClient.chain?.id !== GNOSIS_CHAIN_ID) {
      return addLog(
        `ERROR: Wallet on chain ${walletClient.chain?.id} (${walletClient.chain?.name}), need Gnosis (${GNOSIS_CHAIN_ID})`,
      )
    }

    if (!addresses) return addLog('ERROR: Bee addresses not loaded')

    const recipient = contacts.find(c => c.ethAddress.toLowerCase() === sendTo.toLowerCase())

    if (!recipient) return addLog(`ERROR: Recipient not in contacts: ${full(sendTo)}`)

    try {
      const provider = createNotifyProvider(walletClient)
      const recipientPubKey = hexToBytes(recipient.walletPublicKey)
      const myAddr = signer.getAddress()

      addLog(`Sending notification to ${recipient.nickname}…`)
      addLog(`  contract: ${full(REGISTRY_ADDRESS)}`)
      addLog(`  chain: ${walletClient.chain?.name} (${walletClient.chain?.id})`)
      addLog(`  recipient ETH: ${full(recipient.ethAddress)}`)
      addLog(`  recipient pubKey: ${full(recipient.walletPublicKey)}`)
      addLog(`  payload.sender: ${full(myAddr)}`)
      const t0 = Date.now()
      const txHash = await registry.sendNotification(
        provider,
        REGISTRY_ADDRESS,
        recipientPubKey,
        recipient.ethAddress,
        {
          sender: myAddr,
        },
      )
      addLog(`  duration: ${Date.now() - t0}ms`)
      addLog(`Notification tx: ${full(txHash)}`)
    } catch (e) {
      addLog(`Notification FAILED: ${(e as Error).message}`)
      addLog(`  stack: ${(e as Error).stack?.split('\n').slice(0, 3).join(' | ')}`)
    }
  }

  async function handlePoll() {
    if (!signer) return addLog('ERROR: No signer')

    try {
      const provider = createNotifyProvider()
      const fromBlock = pollFromBlock ? parseInt(pollFromBlock, 10) : 0

      addLog(`Polling notifications from block ${fromBlock}…`)
      addLog(`  contract: ${full(REGISTRY_ADDRESS)}`)
      addLog(`  my address: ${full(signer.getAddress())}`)
      addLog(`  from block: ${fromBlock}`)
      const t0 = Date.now()
      const notifications = await registry.pollNotifications(
        provider,
        REGISTRY_ADDRESS,
        signer.getAddress(),
        signer.getSigningKey(),
        fromBlock,
      )
      addLog(`  duration: ${Date.now() - t0}ms`)

      if (notifications.length === 0) {
        addLog('No notifications')
        addLog(`  → no events found for ${full(signer.getAddress())} from block ${fromBlock} to latest`)
        addLog(`  → make sure the sender used YOUR wallet pubkey for ECIES encryption`)
      } else {
        addLog(`Found ${notifications.length} notification(s):`)
        notifications.forEach(n => {
          addLog(`  block ${n.blockNumber}:`)
          addLog(`    from: ${full(n.payload.sender)}`)
        })
      }
    } catch (e) {
      addLog(`Poll FAILED: ${(e as Error).message}`)
      addLog(`  stack: ${(e as Error).stack?.split('\n').slice(0, 3).join(' | ')}`)
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
              {signer.getAddress()} · pubKey {bytesToHex(signer.getPublicKey())}
            </span>
          ) : walletConnected ? (
            <button onClick={derive} className="underline">
              derive key
            </button>
          ) : (
            'connect wallet to derive Nook address'
          )}
        </div>
        <div>Bee: {addresses ? <span style={{ color: 'rgb(var(--fg))' }}>overlay {addresses.overlay}</span> : '—'}</div>
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
                  {c.nickname} <span style={{ color: 'rgb(var(--fg-muted))' }}>{c.ethAddress}</span>
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
        <div className="border-t pt-3" style={{ borderColor: 'rgb(var(--border))' }}>
          <div className="flex justify-between items-center mb-2">
            <span className="text-xs uppercase tracking-widest" style={{ color: 'rgb(var(--fg-muted))' }}>
              Activity Log
            </span>
            <div className="flex gap-2">
              <button
                onClick={() => {
                  navigator.clipboard.writeText(log.join('\n'))
                  addLog('— log copied to clipboard —')
                }}
                className="text-xs underline"
                style={{ color: 'rgb(var(--fg-muted))' }}
              >
                Copy log
              </button>
              <button
                onClick={() => setLog([])}
                className="text-xs underline"
                style={{ color: 'rgb(var(--fg-muted))' }}
              >
                Clear
              </button>
            </div>
          </div>
          <div
            className="text-xs font-mono space-y-0.5 max-h-96 overflow-auto"
            style={{ color: 'rgb(var(--fg-muted))' }}
          >
            {log.map((line, i) => (
              <div
                key={i}
                style={{
                  color:
                    line.includes('FAILED') || line.includes('ERROR')
                      ? '#ef4444'
                      : line.startsWith('[') && !line.includes('  ')
                        ? 'rgb(var(--fg))'
                        : undefined,
                }}
              >
                {line}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
