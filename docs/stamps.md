# Postage stamps

This doc covers how Nook handles Swarm postage stamps end-to-end: buying, displaying, extending capacity (dilute), extending duration (topup), and the math behind it.

> If you're new to Swarm stamps, the one-line summary: a stamp is a pre-paid right to store data on Swarm. It has a **depth** (how many chunks it can cover) and an **amount** per chunk (how long those chunks stay alive). Stamps don't store the data — they authorize it.

---

## Mental model — what Nook calls things vs. Swarm

Nook abstracts the Swarm terminology in the UI to feel more like a normal app:

| Swarm concept | Nook UI term |
|---|---|
| Postage stamp | Drive |
| Stamp depth × per-chunk amount | "Size" + "Duration" |
| Topup | Extend duration |
| Dilute | Extend capacity |
| Stamp TTL | "Expires in N days" |

Never use *stamp*, *postage*, or *topup* in user-facing strings. The mapping lives in `ui/CLAUDE.md` as the canonical glossary.

---

## Identifiers

A stamp has a few IDs that matter at different layers:

| Field | Source | Meaning |
|---|---|---|
| `batchID` | Bee, returned at purchase | The canonical 64-char hex ID. Used everywhere (upload headers, ACT grantees, feed updates). |
| `label` | Bee, set at purchase | Human nickname for the stamp. Nook uses this as the default drive name; users can override it. |
| `depth` | Bee | Power-of-2 exponent for the number of chunks the stamp covers. |
| `bucketDepth` | Bee | Fixed at 16. Bee buckets chunks into `2^16` buckets for fairness. |
| `utilization` | Bee | Worst-case bucket fill — see *Capacity display* below. |
| `batchTTL` | Bee | Seconds remaining until the stamp expires. |
| `usable` | Bee | Whether the stamp is fully synced and usable for uploads. |
| `immutableFlag` | Bee | Whether chunks may be overwritten. Nook defaults to immutable. |

There's no app-level stamp ID — `batchID` is the canonical one across Bee, Koa, and the UI.

---

## Buying a stamp

### Flow

1. User opens the **New drive** modal on the Drive page.
2. Picks a Size preset and Duration preset, optionally toggles Encrypt.
3. UI calls `POST /buy-stamp` on the Koa backend (`src/server.ts`).
4. Koa proxies to Bee at `POST /stamps/{amount}/{depth}`, with two important headers:
   - `Authorization: Bearer <password>` — required by Bee 2.x
   - `immutable: "false"` or omitted (defaults to immutable)
5. Bee mines the on-chain `CreateBatch` transaction. Returns `batchID` immediately, but `usable: false` until the transaction confirms and the stamp shows up in the postage contract.
6. Nook polls `/stamps` for the stamp to become `usable`. While confirming, the UI shows it with a "Confirming…" indicator and disables uploads.

### Why through Koa, not directly to Bee from the UI

`/buy-stamp` is one of a few endpoints that *must* go through Koa because the Electron renderer strips custom headers on localhost requests, so `immutable: "false"` never reaches Bee from a direct fetch. The Koa proxy injects it server-side.

(History: this caused weeks of confusion before being tracked down. See `src/server.ts` `/buy-stamp` route for the auth + header logic.)

### Cost math

Cost is per-chunk × number-of-chunks:

```
amount per chunk (PLUR) = currentPrice (PLUR/block) × duration (blocks)
total chunks            = 2^depth
total cost (PLUR)       = amount per chunk × total chunks
total cost (BZZ)        = total cost / 10^16
```

Implemented in `ui/src/api/bee.ts → calcStampCost`. The UI displays the BZZ-denominated total in the buy modal.

`currentPrice` comes from Bee's `/chainstate` endpoint and updates over time as network demand shifts.

---

## SIZE_PRESETS and overbuy

Nook does not let the user pick a raw depth. Instead, four named presets map size labels to depths:

| Label | Depth | Bee's effective capacity at this depth | Overbuy factor |
|---|---|---|---|
| 110 MB | 21 | ~2.6 GB | 24× |
| 2.6 GB | 22 | ~7.7 GB | 3× |
| 7.7 GB | 23 | ~20 GB | 2.6× |
| 16 GB | 24 | ~47 GB | 3× |

**Why overbuy?** Bee's `utilization` metric (used for "X% used" displays) is **worst-case bucket fill**, not literal bytes. At low depths (8 chunks per bucket at depth 19) the worst bucket fills wildly faster than average, so a 5 MB upload registers as 25% on a "110 MB" depth-19 stamp. By buying at depth 21+ (32+ chunks per bucket), the worst-bucket metric tracks real fill within ~2×, and the displayed % feels honest.

Tradeoff: small drives cost more than they would at the theoretical minimum depth. We accept that in exchange for a non-misleading capacity bar.

Decision detail: see [ADR-001: variable overbuy](decisions/001-variable-overbuy.md).

### Legacy stamps

Stamps bought before this scheme live at depths 19 / 20. The `NOOK_DISPLAY_CAPACITY` table in `ui/src/api/bee.ts` keeps those depths mapped to their original labels (110 MB / 680 MB) so old drives keep displaying correctly. The capacity bar for legacy stamps will look pessimistic at low fill — that's a known limitation we accept rather than retroactively migrating.

---

## Capacity display ("X / Y MB used")

Each row in the Drive list shows:

- `usedBytes / capacityBytes` — formatted as "X MB / Y MB"
- A percentage bar

Both are derived from Bee's `utilization`:

```
maxUtilization = 1 << (depth - bucketDepth)
usagePct       = utilization / maxUtilization
usedBytes      = capacityBytes × usagePct
```

`capacityBytes` is read from `NOOK_DISPLAY_CAPACITY[depth]` — i.e., the **advertised** capacity (matching the label users picked at buy time), not Bee's larger effective capacity.

This means:
- The number matches what swarm-cli / Bee Dashboard would show for the same stamp — same source of truth
- External uploads (via swarm-cli, ACT internals, feed-update chunks) move the bar, so the display reflects all uploads, not just Nook's
- At overbought depths (21+), the worst-bucket math tracks real fill closely enough that the % feels honest

Implementation: `ui/src/pages/Drive.tsx → DriveCard` (search for `usedBytes`).

---

## Extending a drive — capacity vs. duration

A single modal (`ExtendModal` in `Drive.tsx`) handles both:

- **Extend capacity** — increase the depth (dilute)
- **Extend duration** — extend remaining TTL (topup)

The user can toggle either independently. The modal computes one combined BZZ cost.

### Capacity-only (dilute)

Diluting halves the per-chunk balance every +1 depth. To keep the same remaining TTL after diluting, we have to topup back to the original per-chunk balance:

```
recoverySeconds = currentTTL × (1 - 1/2^depthDelta)
```

That's the duration we have to topup just to recover what dilute took away. Hidden from the user.

### Duration-only (topup)

Pure topup — add `userExtendMonths × secondsPerMonth` worth of price-blocks per chunk.

### Both at once

```
totalSecondsToBuy = recoverySeconds + extendSeconds
amount per chunk  = currentPrice × (totalSecondsToBuy / SECONDS_PER_BLOCK)
total cost (PLUR) = amount per chunk × 2^targetDepth
```

The user sees a single "Cost: X BZZ" number; the recovery math is hidden.

### Call order — topup before dilute

Critical: **topup must be sent before dilute**, with the per-chunk amount scaled by `2^depthDelta`.

Why: dilute halves the per-chunk balance. If the post-dilute balance would drop below the postage contract's minimum, the on-chain tx emits no `BatchDepthIncrease` event and Bee returns `"cannot dilute batch"`. Topping up first keeps the per-chunk balance well above the threshold at the moment dilute runs.

Total BZZ cost is unchanged. Bee charges `amount × current_chunk_count` for topup, so scaling by `2^delta` exactly offsets the depth difference.

Implementation: `ExtendModal.doExtend` in `Drive.tsx`.

### Why not gate on `immutableFlag`?

Earlier prototype gated "Extend capacity" off for immutable stamps on the assumption that Bee rejects dilute on immutable. That assumption is wrong: Bee allows dilute on any stamp regardless of immutability (verified against `bee@v2.8.0` `pkg/postage/postagecontract/contract.go`). The `cannot dilute batch` error is about balance/event mismatch, not immutability.

---

## Stamp purchase observability

The UI shows pending stamps with "Confirming…" indicators (rather than hiding them) so users see *something is happening* immediately after clicking Buy. This is intentional — earlier versions hid pending stamps and the UI looked frozen for 30–60 seconds.

Polling cadence:
- `/stamps` is refetched every few seconds via TanStack Query
- `retry: false` on the Bee query — avoids 3× console spam on RPC blips
- Error state triggers a `slowMs` refetchInterval so we don't hammer Bee while it's recovering

See `ui/src/api/queries.ts` for the TanStack patterns.
