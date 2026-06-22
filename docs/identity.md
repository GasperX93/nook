# Identity

This doc covers how Nook turns a user's wallet signature into a complete cryptographic identity — the keys, the addresses, the storage, the lifecycle, and the gotchas. It's the foundation that messaging, encrypted drives, and contact sharing all build on.

> One-line summary: the user signs a fixed message in MetaMask once; from that signature Nook derives a 32-byte private key, a secp256k1 pubkey, an Ethereum-style address, and an encryption key. The signature is cached so signing happens at most once per device per wallet.

---

## Mental model — what Nook calls things

| Term in code | Term in UI | What it is |
|---|---|---|
| `ethAddress` / `walletAddress` | **Nook address** | 20-byte hex (`0x…`). User-facing ID. *Not* MetaMask's address — it's derived. |
| `walletPublicKey` / `wpub` | (rarely surfaced) | Compressed secp256k1 pubkey from the derived signing key. Used for ECDH + verifying derived-key signatures. |
| `beePublicKey` / `bpub` | "Sharing key" (legacy term) | The **Bee node's** pubkey, fetched from `/addresses`. Used as the grantee ID in ACT. *Not* derived from the wallet — comes from the Bee binary. |
| Contact link | "Contact link" | `nook://contact/v1?addr=…&wpub=…&bpub=…` — bundles all three for one-paste import. |
| Signer | (internal) | The `NookSigner` interface that wraps the derived private key behind methods (`getAddress`, `getSigningKey`, `deriveSharedSecret`). |

**UI rule:** always call the user-facing identifier the **Nook address**. Never "ETH address", "wallet address", or "derived address." History: during hackathon testing a user shared their MetaMask address by mistake; identity resolution failed silently. The label "Nook address" is honest now (it's not your MetaMask) and future-proof if the identifier ever stops being Ethereum-style.

---

## The four keys

A single wallet signature produces four distinct pieces of cryptographic material, each with a specific purpose:

```
signMessage("Nook Key Derivation v1") in MetaMask
   ↓
signatureHex (130 hex chars, 65 bytes including v)
   ↓
masterSeed = keccak256(signatureHex)
   ↓
signingKey    = HMAC-SHA256(masterSeed, "nook:signing")     ─→ feed signing, address derivation
encryptionKey = HMAC-SHA256(masterSeed, "nook:encryption")  ─→ AES-GCM file/mail encryption
   ↓
publicKey (compressed)   = secp256k1.getPublicKey(signingKey, true)
publicKey (uncompressed) = secp256k1.getPublicKey(signingKey, false)
nookAddress              = "0x" + lowerHex(keccak256(uncompressedPub[1:]).slice(-20))
```

Implementation: `ui/src/crypto/signer.ts → createWalletSigner`.

The HMAC step gives **domain separation**: even though both keys derive from the same seed, an attacker who somehow learns the encryption key can't compute the signing key (HMAC is a PRF). This lets us reuse one signature for many independent purposes safely.

### The fixed message

```ts
export const SIGN_MESSAGE = 'Nook Key Derivation v1'
```

**Never change this string.** Changing it changes every derived key. Every contact link, identity-feed publish, and ACT grantee tied to an old key becomes unreadable. The `v1` suffix exists so we *could* migrate to v2 someday — but only with a synchronized rotation flow that re-derives, republishes, and migrates ACT grants.

---

## Why derived, not MetaMask's own pubkey?

Three reasons we accept the upfront sign-and-derive complexity instead of asking MetaMask for `eth_getEncryptionPublicKey`:

1. **Cross-device portability.** The wallet signature on `SIGN_MESSAGE` is deterministic — same wallet, same seed phrase, same Nook address on a new device. MetaMask's `eth_getEncryptionPublicKey` is per-account-per-install and isn't portable.
2. **No prompt per operation.** Once derived and cached, the signer signs and encrypts in-memory. MetaMask's RPC methods would prompt on every sign — unusable for messaging.
3. **Swappable backend.** The `NookSigner` interface is designed to be replaced later (Swarm ID, hardware wallets, whatever) without touching call sites. The wallet-signature variant is just the current implementation.

### Determinism check

Some wallets (cold-storage HSMs, deterministic-but-buggy implementations) produce different signatures for the same message. That would silently corrupt every contact link / encrypted message after a re-sign.

`useDerivedKey.derive()` defends against this by signing twice and comparing:

```ts
const signature1 = await signMessageAsync({ message: SIGN_MESSAGE })
const signature2 = await signMessageAsync({ message: SIGN_MESSAGE })

if (signature1 !== signature2) {
  setError('Your wallet produced different signatures for the same message. ...')
  return null
}
```

Yes, this means MetaMask shows the sign-prompt **twice** on first derive. That's intentional. After the first successful pair, the signature is cached and the user is never prompted again on that device. See `ui/src/hooks/useDerivedKey.ts`.

---

## Storage

The cached identity is the `signatureHex` itself (not the derived keys) — re-deriving from a known signature is cheap, and storing only the seed keeps the on-disk format minimal:

```json
{ "signatureHex": "0x…", "walletAddress": "0x…" }
```

`walletAddress` is stored alongside so we can detect "wrong cache for the connected wallet" and clear it.

### Two-tier backend

`ui/src/store/identity.ts` tries safeStorage first, falls back to sessionStorage:

| Backend | Survives | When used |
|---|---|---|
| **Electron safeStorage** (OS keychain) | App restarts, machine reboots | Production builds, macOS / Windows / Linux with keyring |
| **sessionStorage** | Page refresh, but **not** app quit or wallet disconnect | Dev mode, Linux without a keyring, private browsing |

Encrypted blob lives at `paths.data/identity-cache.bin` when safeStorage is in use. The plaintext signature is never written to disk in any other location.

### Koa endpoints

The renderer accesses safeStorage via Koa routes (`src/identity-cache.ts`):

| Route | Purpose |
|---|---|
| `GET /identity-cache` | Returns `{ available, value }` — `available: false` when keychain unsupported |
| `POST /identity-cache` | Encrypts and persists `{ value }` |
| `DELETE /identity-cache` | Clears the cache (called on wallet disconnect / clear) |

If safeStorage is unavailable, all three endpoints return `available: false` and the renderer transparently falls back to sessionStorage.

### What gets cleared, when

| Trigger | safeStorage | sessionStorage | In-memory signer |
|---|---|---|---|
| Wallet disconnect (`status === 'disconnected'`) | ✓ | ✓ | ✓ |
| Wallet switches to a different address | ✓ | ✓ | ✓ |
| Window close | — | ✓ (browser-managed) | ✓ |
| App quit | — | ✓ | ✓ |
| Machine restart | — | ✓ | ✓ |
| Bee data purge | — | — | — |

Bee data purge is intentionally **not** tied to identity — the wallet identity is independent of the Bee node identity.

---

## Lifecycle on app launch

The flow on every cold start with a previously-connected wallet:

```
1. App boots, Wagmi reconnects → status='reconnecting'
2. useDerivedKey hook fires hydrate()
   - try GET /identity-cache → safeStorage available?
     - yes, blob present → parse, createWalletSigner(sig), set signer    [STOP, no prompt]
     - yes, blob missing → mark hydrated, backend='safe-storage'
     - no (Linux w/o keyring) → fall through to sessionStorage
   - sessionStorage has blob? → parse, createWalletSigner(sig), set signer  [STOP, no prompt]
   - none of the above → signer stays null
3. Wagmi finishes reconnect → status='connected', address=0x…
4. Auto-derive effect fires (only if !signer && !deriving && !declined)
   - signMessageAsync(SIGN_MESSAGE) twice → check determinism
   - createWalletSigner(sig), persist via setSigner()
5. signer is now in memory + persisted; downstream features unblock
```

If the user rejects the auto-derive prompt, `declinedThisSession.current = true` and we don't ping them again on every render — they have to click "Set up Nook identity" on the Identity tab to retry.

---

## What other identifiers exist (and aren't derived)

`bpub` (the Bee node's public key) is **not** part of the wallet-derived chain. It comes from the Bee binary:

```
GET /addresses → { publicKey: "<bpub hex>" }
```

This is fetched via `useAddresses` in the UI. The bpub is:
- Tied to the specific Bee installation (`data-dir/keys/swarm.key`)
- Independent of the user's wallet — same Nook user on two devices = two different bpubs
- Used as the grantee identifier in ACT (see [encryption.md](encryption.md))

A consequence: granting drive access by **Nook address** requires resolving the identity feed to get the current bpub. If the published feed has a stale bpub (e.g., from before a Bee data purge), the wrong key gets granted and the recipient silently lacks access.

---

## How others reach you — two channels

### Channel A: published identity feed

`@swarm-notify/sdk` publishes a record at a deterministic feed:

```
topic = keccak256("swarm-identity-" + ethAddress)
payload = { ethAddress, walletPublicKey, beePublicKey }
```

Anyone with your Nook address can resolve the feed and get your wpub + bpub. Implementation: `identity.publish(bee, signingKey, stampId, payload)` in the SDK, called from `ui/src/pages/Identity.tsx`.

Requires:
- A usable stamp (the feed update writes a chunk)
- The user clicking **Publish to identity feed** (voluntary)

Once published, others can type your Nook address into any Swarm-Notify app (Nook, future tools) and resolve everything needed to message or share with you.

### Channel B: contact link (no publish needed)

A `nook://contact/v1` URL bundles everything in the link itself:

```
nook://contact/v1?addr=0x…&wpub=03…&bpub=03…[&name=Alice]
```

Pasted into the **Add contact** input or the **Share drive** input — Nook decodes and saves the contact. Works without any publish. Codec lives in `ui/src/notify/share-link.ts`.

| Field | Required | Source |
|---|---|---|
| `addr` | yes | `signer.getAddress()` |
| `wpub` | yes | `bytesToHex(signer.getPublicKey())` |
| `bpub` | yes | `addresses.publicKey` (from Bee `/addresses`) |
| `name` | optional | nickname the sharer wants the recipient to see |

`addr` is technically derivable from `wpub` (keccak256-and-truncate). We keep it explicit for debuggability — you can read the link and know whose it is at a glance — and for Swarm-ID future-proofing.

### When to use which

- **Identity feed**: best for "type their address" UX, future search/discovery flows, persistent presence on Swarm.
- **Contact link**: best for direct invitation (DM the link), works offline, doesn't burn a feed update on every key change.

The user picks. Most workflows use both — publish for discoverability, share links for direct invites.

---

## ECDH and message encryption

Messages between Nook users are encrypted with a shared secret derived via ECDH:

```ts
sharedSecret = keccak256(secp256k1.getSharedSecret(myPrivateKey, theirPublicKey).slice(1))
```

Where `theirPublicKey` is the recipient's `wpub` (from contact link or identity feed). Implementation: `signer.deriveSharedSecret(theirPublicKey)` in `crypto/signer.ts`.

This is why both correspondents must have each other's `wpub`. The `bpub` is irrelevant to messaging — that's for ACT/drives. Mixing the two up means messages silently fail to decrypt.

---

## Storage keys reference

| localStorage key | Schema | Owner |
|---|---|---|
| `nook-contacts-v2` | JSON array of `NookContact` | `ui/src/notify/storage.ts` |
| `nook-identity-published:<ethAddress>` | `"true"` if user has published their identity | `ui/src/notify/storage.ts` |
| `nook-onboarding-publish-dismissed` | `"true"` if user dismissed the publish hint | `ui/src/notify/storage.ts` |

| sessionStorage key | Schema | Owner |
|---|---|---|
| `nook.derivedKey.v1` | `{ signatureHex, walletAddress }` | `ui/src/store/identity.ts` |

| Disk file | Schema | Owner |
|---|---|---|
| `<dataDir>/identity-cache.bin` | safeStorage-encrypted JSON `{ signatureHex, walletAddress }` | `src/identity-cache.ts` |

---

## Failure modes & gotchas

### Stale published feed after a Bee data purge

The published identity feed still contains the old `bpub`. New grants by Nook address resolve the stale bpub → grant goes to a key the recipient no longer holds.

**Mitigation today**: republish from the Identity tab.
**Possible future fix**: detect bpub mismatch between resolved feed and the recipient's current bpub at grant-time and surface a "republish needed" prompt.

### Self-grant ambiguity

If you grant drive access to your own Nook address (common during testing), Nook used to auto-add you as a contact named after yourself. We now skip the auto-save when the granted address matches `signer.getAddress()`. The grant itself succeeds — only the contact record is skipped.

### Two MetaMask popups on first derive

Confusing but intentional — see [Determinism check](#determinism-check). After successful derive, the signature is cached and subsequent app launches are silent.

### "Wallet not connected" race during boot

Wagmi's `status` field passes through `'connecting'` and `'reconnecting'` on cold start before settling to `'connected'`. The auto-derive effect waits for `hydrated && status === 'connected'` to avoid prompting during a transient `disconnected` state on page load.

### sessionStorage and dev port mismatch

In dev mode the UI runs on port 3002 (Vite) or 3054 (Koa-served prod build). These are different browser origins → different sessionStorage. If you switch ports mid-session, your in-memory signer survives via sessionStorage on whichever origin you came from, but the other port starts fresh. Recommend sticking to 3002 during dev (see `MEMORY.md` → project_dev_port_gotchas).
