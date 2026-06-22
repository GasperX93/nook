# Messaging (Swarm Notify)

This doc covers how Nook ships in-app messaging on top of the `@swarm-notify/sdk` library: how identity, on-chain notifications, and per-mailbox Swarm feeds combine to deliver "Alice can send Bob a message" without a central server.

> One-line summary: each user has a per-recipient Swarm feed acting as a mailbox. Senders write ECDH-encrypted messages keyed off the recipient's `wpub`; the recipient polls the feed. When Alice is messaging someone who hasn't added her yet, she also fires a tiny on-chain "wake-up" notification so they see her as a pending invitation.

---

## Mental model — three swappable rails

Messaging composes three independent transports:

| Rail | What it carries | Decentralized via | Cost |
|---|---|---|---|
| **Identity feed** | "Who is `0xabc…`?" → wpub + bpub | Swarm feeds | Stamp chunk |
| **Mailbox** | Encrypted messages | Swarm feeds per recipient | Stamp chunk per send |
| **Registry** | "Hey, I want to talk to you" wake-up | Gnosis L2 contract | ~0.001 xDAI gas |

The recipient polls the mailbox feed regardless. The registry is **optional** and used only when the sender knows the recipient hasn't added them yet (so the recipient's mailbox poll wouldn't include the sender's feed). It surfaces the message as an invitation banner that the recipient can accept → adds the sender as a contact → mailbox poll picks up the real message.

Recipients with the sender in their contact list don't need the registry — their mailbox poll already covers that feed.

---

## Identifiers — who is who

Same `wpub` / `bpub` / Nook address layer as [identity.md](identity.md). For messaging specifically:

| Field | Role |
|---|---|
| Recipient's **Nook address** | What the sender types / picks from contacts |
| Recipient's **`wpub`** | Used to derive the ECDH shared secret that encrypts the message |
| Recipient's **`bpub`** | Unused — `bpub` is for ACT/drives, not messaging |

A common mistake when wiring new features: confusing `wpub` (messaging) with `bpub` (drives). The contact link bundles both for exactly this reason — the right key is always at hand.

### `NookContact` schema

```ts
interface NookContact {
  id: string               // Nook address, lowercased
  nickname: string
  walletPublicKey: string  // wpub — required
  beePublicKey: string     // bpub — required
  ensName?: string
  source: 'identity-feed' | 'share-link' | 'drive-share'
  addedAt: number
}
```

All three identity fields are required by construction. There's no "anonymous" contact in Nook — to message someone, you need their wpub. The `source` field is for UX (badge in the contact list) and future-proofing.

`toLibraryContact()` in `ui/src/notify/types.ts` adapts to the swarm-notify SDK's `Contact` shape. The Nook-specific extensions (`source`, `addedAt`) stay local.

---

## Mailbox — per-recipient feed

Each user has **one mailbox per correspondent**. Concretely: when Alice wants to send Bob a message, Alice writes to a Swarm feed whose topic and signer encode "Alice → Bob". Bob reads the same topic to fetch incoming messages from Alice.

The SDK handles the feed topic derivation; Nook just calls:

```ts
await mailbox.checkInbox(bee, mySigningKey, myAddress, contacts)
```

which polls every contact's outbound feed (contact → me) and returns the decrypted messages. Encryption is ECDH between `signingKey` and the contact's `wpub`, so only the recipient can decrypt.

### What's actually transmitted

The `SdkMessage` payload:

```ts
{
  v: 1
  subject: string
  body: string
  ts: number               // unix ms
  sender: string           // ETH address
  type?: 'message' | 'drive-share'
  attachments?: Attachment[]
  driveShareLink?: string  // when type === 'drive-share'
  driveName?: string
  fileCount?: number
}
```

Nook treats `body` as plain text. The optional `type === 'drive-share'` carries an embedded share link so the recipient can one-click import a shared drive (see "Drive-share messages" below).

### Send flow

```
1. User types in the Messages thread, clicks Send.
2. UI calls mailbox.send(bee, mySigningKey, recipient, { body, ts, sender, type? })
   - SDK encrypts with shared secret derived from mySigningKey + recipient.walletPublicKey
   - SDK writes to the recipient-specific feed using mySigningKey as signer
   - Returns when the feed update chunk is uploaded
3. UI appends the message to local threads via appendSent()
4. UI optionally fires registry.sendNotification (see Wake-ups below)
```

### Receive flow

`useInboxPolling` (`ui/src/hooks/useInboxPolling.ts`) runs at the Layout level so messages keep arriving even when the Messages page isn't mounted:

```
every 30 seconds:
  contacts = loadContacts().filter(c => c.id !== myAddr)
  if contacts.length === 0: return
  inbox = await mailbox.checkInbox(bee, mySigningKey, myAddr, contacts)
  for each { contact, messages } in inbox:
    threads = mergeReceived(threads, contact.ethAddress, messages)
  if newCount > 0 && notificationSound && !onContactsPage:
    playCricketChirp()
```

Self is filtered out — if the user added their own contact link for solo testing, every poll would hit `myAddr → myAddr` (404) without the filter.

**Polling cadence**: 30 seconds. Trade-off between responsiveness and Bee RPC load. Increase for battery-friendly mode if needed in the future.

---

## Wake-ups — the on-chain registry

The mailbox polling only checks the feeds of people **already in your contact list**. If Alice sends Bob a message but Bob has never added Alice, his next poll will pass over her feed entirely.

The registry solves this. It's a tiny Gnosis L2 contract at `0x318aE190B77bA39fbcdFA4e84BB7CFD16b846Fcf` (constant in `notify/constants.ts`). Sending an on-chain event there with the recipient's encrypted address as payload tells the recipient "someone wants to reach you" — the recipient discovers it on the next registry poll.

### Send a wake-up

In `ShareModal` and `Messages` "Send invite" flows:

```
1. User opts in via the "Also send on-chain wake-up (~0.001 xDAI)" checkbox.
2. UI signs and submits registry.sendNotification(walletClient, REGISTRY_ADDRESS, recipientAddress)
   - Encrypted payload on-chain; only the recipient can decrypt it.
3. UI records the sent timestamp via recordInviteSent(contactId).
4. tx mines on Gnosis (~5s); event is now in the chain.
```

The user pays gas (~0.001 xDAI) from their connected wallet (not the Nook-managed Bee wallet). This is the only place Nook uses the user's wallet for on-chain writes.

### Receive wake-ups

`useRegistryPolling` (`ui/src/hooks/useRegistryPolling.ts`) runs every 2 minutes (slower than the mailbox; RPC calls are heavier):

```
every 2 minutes:
  fromBlock = getRegistryCursor(myAddr)
  notifications = await registry.pollNotifications(provider, REGISTRY_ADDRESS, myAddr, mySigningKey, fromBlock)
  for each { payload, blockNumber } in notifications:
    if knownContacts.has(payload.sender): skip  # mailbox will deliver
    invitations = addInvitation(invitations, payload.sender, blockNumber)
  setRegistryCursor(myAddr, highestBlock + 1)
```

The cursor stays per-identity (`nook-registry-cursor:<myAddr>`) so each user only re-fetches from where they left off.

Notifications from known contacts are silently dropped — their messages will arrive via the mailbox poll. The registry is purely for first-contact bootstrapping.

### Invitations storage

```ts
interface Invitation {
  senderAddr: string
  blockNumber: number
  ts: number               // first observed locally
  processed: boolean       // false until user adds them as contact
}
```

Persisted at `nook-invitations-v1`. Once the user accepts (adds the sender as a contact), `processed: true` and the invitation drops out of the inbox banner. The next mailbox poll picks up the real message.

---

## Local thread storage

`@swarm-notify/sdk` reads received messages from the contact's outgoing feed but doesn't store anything itself. Nook keeps the local copy for both directions:

```
nook-messages-v1      → { [counterparty]: StoredMessage[] }
nook-messages-read-v1 → { [counterparty]: lastReadTimestamp }
```

`StoredMessage` schema (`ui/src/notify/messages.ts`):

```ts
interface StoredMessage {
  id: string                 // ${ts}-${direction}-${shortBody} for dedupe
  counterparty: string       // OTHER party, lowercased
  ts: number                 // unix ms
  body: string               // plain text
  direction: 'sent' | 'received'
  kind?: 'message' | 'drive-share'
  driveShareLink?: string    // when kind === 'drive-share'
  driveName?: string
  fileCount?: number
}
```

### Why store sent messages locally

The SDK only reads received messages. Sent messages stay in our local cache until the SDK gains a "read my own outbox" call. If a user wipes their localStorage / switches devices, their **sent** message history is lost — received messages can be re-read from the feed.

Long-term improvement tracked separately: persist sent messages somewhere reachable (Swarm-side or backend) so cross-device history works.

### Merge semantics

`mergeReceived(threads, counterparty, received)` replaces the **received** slice for that counterparty with fresh SDK data, preserving **sent** messages. This is idempotent — running it on the same SDK output produces the same thread.

The dedupe key is `id = ${ts}-${direction}-${body.slice(0, 32)}`. If the SDK returns the same message twice (re-poll, etc.), only one ends up in the thread.

---

## Connection state machine

Per-contact connection state is computed at read time from two signals:

- **inbound bridge**: do we have at least one received message from them?
- **outbound bridge**: have we fired a registry wake-up recently?

```
deriveConnectionState(contactId, hasInbound, now) →
  - 'connected'           — hasInbound = true (they've replied at least once)
  - 'invite-sent-fresh'   — we sent an invite within 24h, no inbound yet
  - 'invite-sent-stale'   — invite sent > 24h ago, still no inbound
  - 'not-connected'       — no invite, no inbound
```

`INVITE_STALE_MS = 24 * 60 * 60 * 1000`. The state never gets stored — it's computed from the timestamp + thread contents every time it's queried. That way the state can never disagree with reality.

### How the UI uses it

- **ConnectionStatusBadge** (`ui/src/apps/Messages.tsx`) — green/yellow/gray pill next to the contact name in the embedded thread header
- **Send-button label** in compose:
  - `not-connected` → **"Send invite"** (offers on-chain wake-up checkbox)
  - `invite-sent-fresh` → **"Resend"** (same modal, just label differs)
  - `invite-sent-stale` → **"Resend"** (highlighted; suggests the previous invite likely failed)
  - `connected` → **"Send"** (normal message; no wake-up offered)

The "wake-up" checkbox is only shown for non-connected states. Once you're connected, the recipient's mailbox poll covers everything.

### Recovery semantics

- When the recipient replies → `hasInbound = true` → state flips to `connected`, the invite timestamp is forgotten.
- When you remove a contact → `removeInvitationsFor(senderAddr)` runs so a future wake-up from them re-surfaces as a fresh invitation instead of being deduped against a ghost row.

---

## Unread counts & sidebar badge

```ts
unreadCount(thread, cursor) = thread.filter(m => m.direction === 'received' && m.ts > cursor).length
totalUnread(threads, cursors) = sum across all counterparties
```

The cursor is updated by `markRead(cursors, counterparty, ts)` when the user views a thread — set to `Date.now()` by default, but parameterizable for test scenarios.

The sidebar badge in `Layout.tsx` calls `totalUnread()` on a 2-second interval and on every route change, then passes the result as `badge` to the Contacts SidebarMenuItem. Polling is cheap (localStorage read only); the route-change recompute means opening Contacts clears the pill immediately as cursors update.

The `99+` cap is rendered by the Sidebar primitive — totals over 99 stay as "99+".

---

## Cricket chirp

Audio notification on new received messages. ~30 lines of Web Audio API synth at `ui/src/lib/cricket.ts` — no asset, no network.

### Gating

A chirp plays only when **all** of:
- New messages were added to a thread in the latest inbox poll
- `useAppStore.notificationSound === true` (toggle in Settings)
- `document.hidden === true` **OR** the current route isn't `#/contacts`

Logic lives in `useInboxPolling.ts` right after `mergeReceived`. The check `window.location.hash.startsWith('#/contacts')` does the on-Contacts detection — hash routing means we read from `location.hash` instead of `pathname`.

### Why hidden-or-not-on-Contacts

Goldilocks zone:
- **Hidden-tab only**: too quiet — user can be in Drive and miss messages entirely
- **Always**: too loud — every reply in an open thread chirps
- **Hidden OR off-Contacts**: silent when the user is looking at the conversation; audible otherwise

### The autoplay-policy gotcha

Browsers block AudioContext until the first user gesture. The Settings toggle click counts as that gesture — toggling the chirp on unlocks the context for the rest of the tab session. After that, chirps fire freely.

If the toggle has never been clicked in the session, the very first chirp might be inaudible until the user interacts with the page. The toggle persists to localStorage (`nook:notification-sound`) so the *preference* survives — but the AudioContext unlock is per-session.

### Settings UI

Settings → Notifications card, single button: **Sound on** (filled) / **Sound off** (outline). Default: on.

---

## Drive-share messages

A drive share doubles as a message. When User A grants User B drive access via the ShareModal and ticks "Send notification to B", Nook:

1. Generates the drive share link.
2. Sends a `mailbox.send` call with `type: 'drive-share'` and the link in `driveShareLink`.
3. Local thread gets a `kind: 'drive-share'` entry via `appendSentDriveShare()`.

The recipient's UI renders these as a card with **Add drive** button instead of plain text. Clicking "Add drive" runs the existing "Add shared drive" flow with the link pre-filled — they get the drive in their **Shared with me** tab.

Why bundle the share with a message instead of two separate operations: the recipient gets a single notification flow ("Crt 1 shared 'HackWeekEncrypted' with you · 1 file") rather than discovering the share silently in their drive list.

---

## Failure modes & gotchas

### Identity feed stale on either side

Same problem as drives — covered in [identity.md](identity.md). If the sender or recipient's published identity feed has an old `wpub`, the ECDH shared secret is wrong and the message can't be decrypted. The mailbox SDK silently skips messages that fail to decrypt, so the recipient just sees nothing.

**Mitigation**: republishing the identity feed fixes it for future messages. Old messages stay undecryptable.

### Registry RPC blip

The registry-poll hook catches errors silently and retries on the next tick. If the Gnosis RPC is down, wake-ups don't arrive until it recovers; users with mailbox-connected contacts are unaffected.

### Pending invitation from removed contact

If user A removes contact B, then B sends a wake-up, the invitation should resurface. `removeInvitationsFor` is called on contact removal so the dedupe doesn't suppress new pings. (Without this, a previously-processed invitation row would cause new wake-ups from the same address to be silently dropped.)

### Per-origin localStorage

Threads, contacts, invitations, cursors — all in localStorage. The dev-mode 3002 vs 3054 port confusion (see project memory `project_dev_port_gotchas.md`) means users testing on both ports will see different message history. Issue #47 tracks moving this state to backend storage.

### Drive shares to non-grantees

A drive-share message includes the share link, but the recipient still needs to be on the grantee list to decrypt. If the sender sends the message but forgets to actually add the recipient as a grantee, the recipient sees the share card but can't read the drive (403 on the metadata fetch). The ShareModal flow does both in one click; if you script grants and messages separately, easy to mess up.

---

## Code path quick reference

| Concern | File |
|---|---|
| Local thread store | `ui/src/notify/messages.ts` |
| Read cursors / unread counting | `ui/src/notify/messages.ts → unreadCount, totalUnread, markRead` |
| Contact storage | `ui/src/notify/storage.ts` |
| Contact schema + adapter | `ui/src/notify/types.ts` |
| Connection state machine | `ui/src/notify/contact-state.ts` |
| Invitations storage | `ui/src/notify/invitations.ts` |
| Mailbox polling hook | `ui/src/hooks/useInboxPolling.ts` |
| Registry polling hook | `ui/src/hooks/useRegistryPolling.ts` |
| Sidebar badge wiring | `ui/src/components/Layout.tsx` — search `unreadCount` |
| Cricket synth | `ui/src/lib/cricket.ts` |
| Cricket toggle in Settings | `ui/src/pages/Settings.tsx` |
| Notification preference | `ui/src/store/app.ts → notificationSound` |
| Registry contract address | `ui/src/notify/constants.ts → REGISTRY_ADDRESS` |
| Wallet provider for registry | `ui/src/notify/provider.ts → createNotifyProvider` |
| Messages UI | `ui/src/apps/Messages.tsx` |
| Embedded Messages in Contacts | `ui/src/pages/Contacts.tsx` |
