# Contacts v2 — testing guide

Tests the new Contacts page (`/contacts` route, sidebar entry between Drive and Account) and the share-link contact import flow. Tracks [#54](https://github.com/GasperX93/nook/issues/54).

What's new vs Phase 1a:
- Contacts page lives in the main UI navigation (no longer Dev-page-only)
- Two add modes: **Find on registry** (paste Nook address) or **Paste share link** (paste a `nook://contact?…` URL)
- Identity publishing is voluntary — share-link path works without publishing
- swarm-notify SDK bumped to `afc9675` (PR #41 — overlay removed; `myEthAddress` replaces `myOverlay` in mailbox calls)

## What you need

- Nook clone, `feat/contacts-page` branch
- Wallet (any EVM wallet)
- Funded Bee node, light mode, at least one usable stamp (only required if you want to publish to the registry — share-link mode works without)
- For the deep-link test below: nothing extra; it works in browser

## 1. Update your branch

```bash
cd <your nook clone>
git fetch
git checkout feat/contacts-page
git pull
cd ui && rm -rf node_modules/.vite && npm install && cd ..
```

The `rm -rf node_modules/.vite` is the gotcha that bit us last time — the SHA bump means Vite needs to re-optimize the new SDK on next start, and its cache is otherwise sticky.

## 2. Start Nook

```bash
npm start
```

Wait ~30-60s for the Electron tray + Vite `ready`.

## 3. Open Contacts

Get your API key (`cat ~/Library/Application\ Support/Nook/api-key.txt` on macOS — adjust per your OS) and open in any browser:

```
http://localhost:3054/?v=<YOUR_KEY>#/contacts
```

> Use **port 3054** (Koa, built UI) for everyday testing. Port 3002 (Vite live source) only matters when actively editing UI code.

You should see "Contacts" in the sidebar between Drive and Account, and the page renders with three sections: your Nook address, an Add contact form (with mode toggle), and the saved contacts list. An orange onboarding hint should appear at the top if you haven't published.

## 4. Solo smoke test

1. **Connect wallet** (top right).
2. Click **Derive key** in the "Your Nook address" card. Approve in your wallet.
3. The card should now show your Nook address (e.g., `0x6e6f83…d5a1`) with a **Copy** button next to it.
4. Click **Copy share link** → paste somewhere to verify. Should look like:
   ```
   nook://contact?addr=0x6e6f83…d5a1&wpub=039850d046…&bpub=036f863a…
   ```
   Three params (addr, wpub, bpub), no overlay, no name (since you didn't add one).
5. *(Optional, requires usable stamp)* Click **Publish to registry**. After ~5–10s the status pill flips to **Published** in green. The orange onboarding hint disappears.
6. *(Optional)* Click **Republish** — same status, no error.

If steps 1–4 all work and the share link decodes correctly, your setup is good.

## 5. Two-party test (coordinate with Gasper)

This is the real product test — exchanging contact info two ways and verifying both paths reach the same outcome.

### A. Add each other via share link (no registry needed)

1. Both: click **Copy share link** on your own Contacts page.
2. Send each other your share link out-of-band (Telegram / Discord / etc.).
3. Both: in the Add contact section, switch radio to **Paste share link** → paste the link → confirm decoded preview shows correct address + "All keys present ✓" → optionally type an override nickname → **Add from share link**.
4. Verify the contact appears in the saved list with a small **share link** badge next to the nickname.

### B. Add each other via registry (requires both to have published)

1. Both: confirm your "Your Nook address" card shows **Published** ✓ (run step 4.5 above first if not).
2. Both: tell each other your Nook address (just the `0x…` string).
3. Both: switch radio to **Find on registry** → paste the other's Nook address + nickname → **Look up & add**.
4. Verify the contact appears with a **registry** badge.

### C. Verify both contact types are messageable

If we have time: navigate to the Dev page (`#/dev`), find the **Swarm Notify** panel, and try `Send message` to one of your new contacts — it should work for both share-link-added and registry-added contacts (they're identical from the SDK's perspective).

## 6. Deep-link test (browser flow)

The OS-level `nook://contact?…` click only works in packaged builds. The dev-mode equivalent is to put `&contact=…` directly in the dashboard URL — same code path is exercised.

```
http://localhost:3054/?v=<YOUR_KEY>&contact=nook%3A%2F%2Fcontact%3Faddr%3D0xabc%26wpub%3D03de…%26bpub%3D03ff…&name%3DGasper#/contacts
```

(URL-encode the `nook://...` value as the `contact` param.)

Expected behaviour: Contacts page opens with the Add mode toggle already on **Paste share link** and the textarea pre-filled with the decoded share link. The `?contact=` param is then stripped from the URL so a refresh doesn't re-prefill.

## What we're looking for

| Test | Pass criteria |
|---|---|
| Contacts in sidebar | Appears between Drive and Account |
| Page renders | All three sections visible, no console errors |
| Copy own Nook address | Clipboard contains `0x…` matching what's shown |
| Copy share link | Clipboard contains a `nook://contact?addr=…&wpub=…&bpub=…` URL |
| Publish to registry | Status pill flips to **Published** in green within 10s |
| Add via share link | Decoded preview is correct; contact appears tagged "share link" |
| Add via registry | Contact appears tagged "registry" |
| Both contact types | Identical capabilities (both can receive messages, both work for ACT) |
| Deep-link prefill | `?contact=` URL param auto-fills share-link form on Contacts page |

## Known limitations of this v1

- Contacts persist in localStorage (`nook-contacts-v2`) — per-origin, so port changes still wipe your view. Tracked at #47.
- No QR code generation yet for share links (just text copy)
- No edit / try-resolving-again on existing contacts (Phase 1c)
- OS-level `nook://` only works in packaged builds (PR #38's same constraint)

## What to report back

For any failure, paste into a comment on [#54](https://github.com/GasperX93/nook/issues/54):

- Which test step
- Browser devtools **Console** tab output
- The clipboard contents (for the share-link tests)
- Bee mode (`light` / `ultra-light`) — Dev page → Node config
