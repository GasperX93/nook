# Encrypted drives & ACT

This doc covers how Nook builds encrypted, shareable drives on top of Bee's Access Control Trie (ACT) primitive. It's the layer that makes "share a drive with Alice without exposing it to the public network" work.

> One-line summary: encrypted drives are normal Nook drives whose files are uploaded with `swarm-act: true`. ACT lets Bee restrict reads to a list of grantee public keys (`bpub`s). Nook adds a metadata feed on top so the file list itself is also encrypted and so grantees see drive updates without polling every chunk.

---

## Mental model — three layers, one ACT history chain

An encrypted drive in Nook has three independent layers, all operating on the **same ACT history chain**:

```
┌─────────────────────────────────────────────────────────────┐
│  Layer 3 — Metadata feed (Nook application layer)           │
│  Public Swarm feed → points to ACT-encrypted JSON           │
│  describing the file list. Topic: keccak256(batchId +       │
│  "nook-drive-meta"). Wrapper public; payload encrypted.     │
└─────────────────────────────────────────────────────────────┘
                          ↓ references
┌─────────────────────────────────────────────────────────────┐
│  Layer 2 — Grantee list (Bee /grantee endpoints)            │
│  List of bpub identifiers permitted to decrypt. Adding or   │
│  removing a grantee writes a new ACT history entry.         │
└─────────────────────────────────────────────────────────────┘
                          ↓ keyed by
┌─────────────────────────────────────────────────────────────┐
│  Layer 1 — Files (Bee /bzz with swarm-act: true)            │
│  Each chunk encrypted. Each upload writes a new entry into  │
│  the ACT history chain.                                     │
└─────────────────────────────────────────────────────────────┘
```

**The critical invariant**: every operation (file upload, grantee add/revoke, metadata update) returns a new `Swarm-Act-History-Address`. That address must be passed to the **next** operation. Breaking the chain means grantees lose access to everything written after the break — Bee can't link the new operation to the existing grant list.

The latest history address lives in `LocalDriveMetadata.actHistoryRef` (localStorage). After every ACT op, Nook reads the response header `Swarm-Act-History-Address` and stores it.

---

## Identifiers

| Field | Type | Source | Purpose |
|---|---|---|---|
| `batchID` | 64-char hex | Bee `/stamps` | The stamp. Drives a 1:1 mapping — one stamp = one drive. |
| `actPublisher` | 66-char hex (compressed secp256k1) | Bee `/addresses → publicKey` | The Bee node's pubkey under which content was encrypted. Recipients need it to decrypt. |
| `actHistoryRef` | 64-char hex | Response header on every ACT op | Latest entry in the chain. Threads each op forward. |
| `granteeRef` | 64-char hex | Returned by `POST /grantee` | The current grantee-list reference. Updated by add/revoke. |
| `metadata feed topic` | 64-char hex | `keccak256(batchId + "nook-drive-meta")` | Per-drive deterministic feed where the metadata pointer lives. |
| `metadataRef` | 64-char hex | Output of metadata upload | The ACT-encrypted JSON blob; feed points here. |
| `metadataHistoryRef` | 64-char hex | Response header on metadata upload | ACT history after the metadata write. |

**Important: `actPublisher` is `bpub`, not `wpub`.** ACT encrypts content under the Bee node's key, not the wallet's. The metadata feed itself is signed by the wallet-derived signing key, but the encryption layer is `bpub`-rooted.

---

## Why `bpub` for ACT (and not the wallet-derived key)?

Bee's ACT implementation pre-dates Nook's wallet-derived signer. The Bee node generates and stores its own keypair at `<data-dir>/keys/swarm.key`; that's the only key Bee can use to encrypt chunks via ACT today. We feed `bpub` into the grantee list because Bee will only decrypt for grantees keyed off Bee node keys.

Consequences:
- A user's encrypted-drive access is **tied to their specific Bee installation**. Reinstalling = new `bpub` = lost access to existing grants.
- Two devices for the same user need to be granted separately (each device has its own `bpub`).
- Cross-device portability needs an upstream Bee change ("external-signer ACT" — see [project memories](../.claude/...) — not yet shipped).

Until that lands, Nook treats the wallet-derived identity (`wpub`) as the **portable identity** and `bpub` as the **per-device encryption identity**. The contact link bundles both so newer Nook versions can use `bpub` today and migrate to `wpub` later without breaking existing contacts.

---

## File upload flow (encrypted drive)

```
1. UI calls beeApi.uploadFileWithACT(file, stampId, historyRef?)
2. UI POSTs to /bzz on Bee with headers:
     swarm-postage-batch-id: <stampId>
     swarm-act: true
     swarm-act-history-address: <historyRef>   // omitted on first upload
     (No "/act/upload" Koa proxy needed — uploads go direct to Bee.)
3. Bee returns:
     - reference: <chunk hash>
     - response header Swarm-Act-History-Address: <newHistoryRef>
4. Nook stores newHistoryRef as actHistoryRef in LocalDriveMetadata.
5. Nook writes a new metadata feed entry (see "Metadata feed write" below).
```

Routing: file uploads go **direct to Bee** (port 1633 / `/bee-api` in dev). The `swarm-act-*` headers aren't header-stripping victims like `immutable` is on `/buy-stamp` — browsers preserve them on direct fetches.

---

## File download flow (encrypted drive)

```
1. UI calls beeApi.downloadFileWithACT(reference, actPublisher, historyRef)
2. UI GETs /act/download/<reference>?publisher=<bpub>&history=<historyRef> on Koa
3. Koa proxies to Bee at GET /bzz/<reference> with headers:
     swarm-act: true
     swarm-act-publisher: <bpub>
     swarm-act-history-address: <historyRef>
4. Bee checks: is the requesting Bee node in the grantee list for this history?
   - Yes → decrypts and streams the file
   - No → 403
```

The Koa proxy exists for download because the browser **does** strip `swarm-act-*` headers on cross-origin fetches in production (the dashboard is served from one port, Bee runs on another). Hence `/act/download` injects them server-side. See `src/server.ts` around line 400.

---

## Grantee management

Three Koa routes wrap the Bee `/grantee` endpoints. They exist because (a) header injection again, and (b) we want a unified place to log/validate.

| Route | Bee underneath | Purpose |
|---|---|---|
| `POST /grantee` | `POST /grantee` | Create the initial grantee list. Returns `ref` + new `historyRef`. |
| `PATCH /grantee/:ref` | `PATCH /grantee/:ref` | Add or revoke grantees on an existing list. Returns updated `ref` + new `historyRef`. |
| `GET /grantee/:ref` | `GET /grantee/:ref` | List current grantees (debug + UI display). |

All three preserve the ACT history chain: every mutating call returns a new `Swarm-Act-History-Address` that must thread into the next op.

### Grant inputs accepted by ShareModal

`handleGrant` in `ui/src/components/ShareModal.tsx` accepts three input formats — all resolve to a `bpub` before calling `createGrantees`/`patchGrantees`:

1. **Nook address** (`0x… 42 hex`) — resolve via `identity.resolve(bee, address)` → `bpub` from the published identity feed.
2. **Contact link** (`nook://contact/v1?…`) — decode → `bpub` from the URL payload. Also auto-saves the contact to localStorage.
3. **Raw bpub** (66 or 130 hex chars) — used directly. Fallback for power users / out-of-band keys.

Self-grants (address matches `signer.getAddress()`) skip the contact auto-save step but the grant itself proceeds — Nook users granting their own drive to test sharing is common and intentional.

### Revoke

Same `PATCH /grantee/:ref` with the bpub in the `revoke` array. Bee removes the bpub from the list; the next history entry is gated on the smaller list.

**Revoking doesn't remove existing access** to already-downloaded content. The revoked user can no longer decrypt **future** uploads or new metadata-feed updates. Anything they cached locally before revocation is theirs.

---

## Metadata feed — Nook's application layer

The grantee + ACT layers alone don't give grantees a way to know **what's in the drive**. They'd have to know every file reference out-of-band. The metadata feed solves this:

```
Drive Owner's Bee:
  topic = keccak256(batchId + "nook-drive-meta")
  signer = wallet-derived signing key (NookSigner.getSigningKey())
  feed reader/writer at this topic
    ↓
  Latest feed value = reference to ACT-encrypted metadata JSON
    ↓
  Decrypted payload (DriveMetadata):
    { name, encrypted, created, actPublisher, actHistoryRef,
      granteeRef, granteeCount, files: [{ name, reference, historyRef, size, type, uploadedAt }, …] }
```

Key properties:
- **Topic is public** — anyone can read the feed wrapper, but the payload it points to is ACT-encrypted. Non-grantees can see the drive exists; they can't decrypt the file list.
- **Topic is deterministic per stamp** — no need to share a topic; recipients derive it from `batchId`.
- **Signer is wallet-derived** (not `bpub`). The feed writer needs the owner's private key, which Bee's swarm-key isn't well-suited for sharing. Using `signingKey` keeps Bee unaware of who's writing the feed.
- **Metadata payload is full file list** — clients reading the feed get the complete drive state in one ACT-decrypted fetch. No mantaray walking on the client side.

Implementation: `ui/src/api/feeds.ts`.

### Metadata write flow

```
1. UI updates DriveMetadata object (adds/removes a file entry, etc.)
2. POST /act/upload-metadata to Koa with the JSON + current historyRef
3. Koa POSTs to Bee /bzz with swarm-act headers, returns reference + new historyRef
4. UI writes the new reference to the metadata feed:
     bee.makeFeedWriter(topic).uploadReference(stampId, metadataRef)
5. UI updates LocalDriveMetadata.actHistoryRef to the new historyRef
```

Feed updates use `bee-js`'s `makeFeedWriter` — never reimplement the SOC-signing yourself. (We tried; it fails with `400 chunk write error`. bee-js handles all the signing/format correctly.)

### Metadata read flow

```
1. UI calls readDriveMetadata(signer, batchId, actPublisher, actHistoryRef)
2. Compute topic = keccak256(batchId + "nook-drive-meta")
3. bee.makeFeedReader(topic, ownerAddress).downloadReference() → metadataRef
4. GET /bee-api/bzz/<metadataRef> with swarm-act headers (via Koa /act/download)
5. Decrypted text is JSON → parse as DriveMetadata
6. If any step fails, return null (drive shows as "no access")
```

Non-grantees fail at step 4 with 403. Their UI sees the drive but can't list the files.

---

## Share links

Share links transport the **information needed to read a drive**, not access itself. Adding someone as a grantee is a separate, intentional step.

### Feed-based (modern)

```
swarm://feed?topic=<hex>&owner=<wpubAddress>&publisher=<bpub>
```

The recipient's app:
1. Reads the feed at `topic` owned by `owner`.
2. Gets the metadata reference.
3. Attempts ACT-decrypt with `publisher` (the owner's `bpub`).
4. If successful → drive renders, file list visible. If 403 → drive listed but un-readable, with a "request access" prompt.

This is the format the **Share contact link → Add shared drive** flow uses today.

### Legacy snapshot

```
swarm://snapshot?ref=<hex>&publisher=<bpub>
```

Older format — a fixed metadata snapshot at a specific reference. No auto-updates as the owner adds files. Kept around for backwards compatibility but new share UIs default to the feed form.

### What share links don't do

- **They don't grant access.** Pasting a link gives the recipient the *coordinates* to read; they're still blocked by ACT until the owner adds their `bpub` to the grantee list.
- **They don't bundle decryption keys.** Decryption is gated by `bpub` enrollment on the owner's side, not by anything in the link.
- **They don't auto-update past a key rotation.** If the owner's `bpub` changes (data purge), all previously-shared feed links break.

---

## LocalDriveMetadata — per-drive state in localStorage

```ts
interface LocalDriveMetadata {
  encrypted: boolean
  actPublisher?: string         // bpub at time of drive creation
  actHistoryRef?: string        // latest ACT history (advanced on every op)
  granteeRef?: string           // current grantee-list ref
  granteeCount?: number         // including owner
  creatorWpub?: string          // for future migration to wpub-based ACT
}
```

Persisted in localStorage under `nook-drive-metadata`. Keyed by `batchID`.

Why localStorage instead of always reading the feed:
- Fast lookup at app boot — UI can show "Encrypted" badge without a network call
- Survives temporary Bee unavailability
- The metadata feed is the source of truth; localStorage is a cache

If the cache disagrees with the feed, the feed wins. The cache is updated after every successful operation.

### `creatorWpub` — migration anchor

When/if Swarm ships **portable stamps + external-signer ACT**, drives will migrate from `bpub` keying to `wpub` keying. The current Bee-node-bound model is a stopgap. We store `creatorWpub` on drives created after that field landed so the migration script can re-anchor each drive from `bpub` to `wpub` without losing access. Drives created before this field exists will need a manual re-grant during migration.

---

## Failure modes & gotchas

### Broken history chain

If a client writes an ACT operation without passing the latest `historyRef`, Bee can't link the new entry to the existing grants. Grantees retain access to anything in the chain up to the break, but lose access to everything after.

Defenses:
- `LocalDriveMetadata.actHistoryRef` is updated after every op (file upload, grantee add/revoke, metadata write).
- Koa endpoints log the request `historyRef` so we can audit chains.
- TODO: a "repair drive history" tool that walks the feed and re-threads. Not yet built.

### Grantee bpub stale due to reinstall

User A grants User B by Nook address. The identity feed resolves B's old `bpub` (from before B reinstalled). Grant succeeds on Bee's side, but B's current Bee node has a different key → B can't decrypt.

**Symptom**: B sees the drive in "Shared with me" but every download returns 403.

**Fix today**: B republishes their identity feed. A revokes the old `bpub` grant and adds B's new `bpub`. Tedious.

**Possible future fix**: detect during grant when the resolved `bpub` doesn't match the recipient's currently-published `bpub` and prompt the user to re-resolve.

### Metadata feed read by non-grantee

By design: the feed itself is readable by anyone, but the metadata payload is ACT-encrypted. `readDriveMetadata` returns `null` on a 403 from the metadata download. The UI surfaces this as "Drive imported but you don't have access — ask the owner to grant your Nook address."

### Two writers to the same drive

Each Nook drive has exactly one owner — the wallet that created the stamp. The metadata feed is signed by that owner's wallet-derived key. If a grantee wanted to add files, they'd need to be issued the owner's signing key (we don't support this) or run a separate metadata feed (we don't support this either).

**Today: encrypted drives are single-writer, multi-reader.** Multi-writer collaboration is out of scope.

### Revoke is permanent for the chain, but not for cached content

Bee's revoke removes the bpub from the future grantee list. It doesn't and can't reach back into anything the revoked user already downloaded. If they cached files locally, those stay theirs.

If a user really needs to lock out a former grantee from future uploads, revocation is sufficient. If they need to lock the user out of past content, the only path is to create a new drive, re-upload, and not invite them. This is inherent to Swarm's content-addressed model.

---

## Code path quick reference

| Concern | File |
|---|---|
| Encrypted file upload | `ui/src/api/bee.ts → uploadFileWithACT` |
| Encrypted file download | `ui/src/api/bee.ts → downloadFileWithACT` (Koa proxy) |
| Metadata read | `ui/src/api/feeds.ts → readDriveMetadata` |
| Metadata write | `ui/src/api/feeds.ts → writeDriveMetadata` |
| Grantee add/revoke | `ui/src/api/server.ts → createGrantees / patchGrantees` |
| Grantee proxy routes | `src/server.ts` — search "/grantee" |
| ACT download proxy | `src/server.ts` — search "/act/download" |
| ACT metadata upload proxy | `src/server.ts` — search "/act/upload-metadata" |
| Per-drive cache | `ui/src/hooks/useDriveMetadata.ts` |
| Share-link encode/decode | `ui/src/notify/share-link.ts` |
| Grant flow UI | `ui/src/components/ShareModal.tsx` |
| Add-shared-drive UI | `ui/src/components/AddSharedDriveModal.tsx` |
