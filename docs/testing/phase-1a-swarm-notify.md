# Phase 1a — swarm-notify two-party test

Tests the Dev page panel that exercises every public API in the [swarm-notify](https://github.com/GasperX93/swarm-notify) library end-to-end against a real Bee node and Gnosis Chain. Closing condition for [#41](https://github.com/GasperX93/nook/issues/41).

This is a **smoke test before Phase 2**. We're not validating UX or polish here — only that every library call wires through Nook's stack and round-trips correctly between two real users.

## What you need

- A Nook clone with the `feat/add-swarm-notify` branch checked out
- A wallet (any EVM wallet — MetaMask, Rabby, Rainbow…)
- A funded Bee node (light mode, with at least one usable postage stamp)
- For step 5 only: ~0.001 xDAI on Gnosis Chain for the on-chain notification

## 1. Get the branch

```bash
cd <your nook clone>
git fetch
git checkout feat/add-swarm-notify
git pull
npm install
cd ui && npm install && cd ..
```

`ui/package.json` adds `@swarm-notify/sdk` as a git dependency. Install pulls + builds it via the `prepare` script — this can take ~30s the first time.

### Bee API proxy for Vite dev server

If `ui/.env.development` does not exist, create it so the Vite dev server (port 3002) can reach the Bee API without CORS errors:

```bash
cat > ui/.env.development <<'EOF'
# In dev mode, Bee API calls go through the Vite proxy to avoid CORS issues.
# The proxy rule in vite.config.ts rewrites /bee-api/* -> localhost:1633/*
VITE_BEE_API_URL=/bee-api
EOF
```

Without this file, port 3002 shows the Bee node as "off" even when it's running — the browser blocks direct cross-origin requests to `localhost:1633`.

## 2. Start Nook

```bash
npm start
```

Wait ~30-60s for the Electron tray icon + Vite to log `VITE v7.3.1 ready`.

## 3. Open the Dev page through Vite

Get your API key:

| OS | Command |
|---|---|
| macOS | `cat ~/Library/Application\ Support/Nook/api-key.txt` |
| Linux | `cat ~/.local/share/Nook/api-key.txt` |
| Windows | `type %LOCALAPPDATA%\Nook\Data\api-key.txt` |

Open in any browser:

```
http://localhost:3002/?v=<YOUR_KEY>#/dev
```

Scroll past the **Wallet Key Derivation** panel — the new **Swarm Notify** panel is below it.

> **Why Vite (port 3002) and not the built UI on Koa (3054)?** The built UI on `localhost:3054` is whatever was compiled at the start of `npm start`. Vite serves the live source, so changes pulled from the branch are reflected immediately. For testing PR work, always use `:3002`.

## 4. Solo smoke test (~2 min)

Verify your environment before coordinating with the other tester.

1. **Connect your wallet** (top-right of any page).
2. In the **Wallet Key Derivation** panel: click **Derive** and approve the signature in your wallet. The activity log should report your derived address + key fingerprints.
3. **Confirm a usable stamp** exists. The Swarm Notify panel's status row will show one in a dropdown if so. If not: Account → My Storage → buy a small one and wait for "usable" to flip to true (~30-60s after purchase).
4. In the **Swarm Notify** panel:
   - Click **Publish my identity** → activity log: `Identity published for 0x…`
   - Copy your derived ETH address from the status row (it's the address starting `0x…`, **not** your MetaMask address — they're different).
   - Paste it into the Resolve input field → click **Resolve identity** → activity log: `Resolved: overlay=… walletPubKey=…`

If both succeed, your setup is good. If either fails, screenshot the activity log + browser console errors and report back before continuing.

## 5. Two-party test (coordinate live)

Once both testers have step 4 green:

1. **Exchange derived ETH addresses.** Use the address shown in the Swarm Notify status row — **not** your MetaMask address. They differ because Nook derives a separate signing key from a wallet signature (see `ui/src/crypto/signer.ts`).
2. Each side: paste the other's address + a nickname into the Add contact form → **Add contact**. The activity log should report `Added contact <nickname>`.
3. **Sender**: paste recipient's ETH address into the message form, type a subject + body → **Send message**. Activity log: `Sent to <nickname>`.
4. **Recipient**: click **Check inbox**. Activity log should list the message subject + body.
5. *(Optional — needs ~0.001 xDAI on Gnosis Chain.)* Test first-contact discovery:
   - Switch your wallet to **Gnosis Chain**. The status row warns if you're on the wrong chain.
   - **Sender**: click **Send on-chain notification**. Wait a few seconds for the tx. Activity log: `Notification tx: 0x…`.
   - **Recipient**: leave `from block` empty (defaults to 0) and click **Poll notifications**. Activity log should report the sender's payload (`block N: from 0x… feed 0x…`).

## What we're looking for

| Test | Pass criteria |
|---|---|
| Publish identity | activity log says `Identity published for <your eth>` and no errors in browser devtools console |
| Resolve identity (self) | round-trip succeeds; logs same overlay we'd expect for our Bee node |
| Resolve identity (other) | resolves the other tester's keys |
| Add contact | contact appears in the list under the form |
| Send message | activity log: `Sent to <nickname>`; no errors |
| Check inbox | recipient sees subject + body of the sent message |
| Send notification | tx hash logged; visible on [Gnosisscan](https://gnosisscan.io/) within 30s |
| Poll notifications | recipient sees sender's address + feed topic |

## What to report back

For any failure, paste into a comment on [#41](https://github.com/GasperX93/nook/issues/41):

- The full activity log of the failing panel (copy the lines under the buttons)
- Browser devtools **Console** tab — any red errors
- Browser devtools **Network** tab — any 4xx/5xx responses to `/bee-api/*` or `https://rpc.gnosischain.com`
- Bee node mode (`ultra-light` vs `light`) — visible at the top of the Dev page config
- OS + Node version

For successes, a one-line confirmation per test is enough — no screenshots needed.

## Known limitations of this panel

This is a smoke test, not a real product:

- Contacts are **in-memory only**. Refreshing the page wipes them.
- Stamp picker shows the first usable stamp; you can override but it's not persisted.
- No retry, no error UX beyond the activity log.
- Polling notifications from block 0 each call. In Phase 3 we'll persist `lastPolledBlock` per identity.
- The panel is gated behind dev mode. In a packaged build, only users with developer mode enabled in Settings will see it.
