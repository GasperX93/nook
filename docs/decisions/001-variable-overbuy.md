# ADR-001: Variable-overbuy SIZE_PRESETS

**Status:** Accepted (May 2026)

## Context

Bee's `utilization` field — the source of "X% used" displays across every Swarm tool (swarm-cli, Bee Dashboard, Beeport, Swarm Desktop) — is **worst-case bucket fill**, not literal bytes uploaded. Concretely:

```
utilization% = utilization / 2^(depth - bucketDepth)
```

where `bucketDepth = 16` always. Chunks hash into `2^16` buckets. The metric tracks the most-filled bucket, so even a tiny upload can pin one bucket near 100% while every other bucket is empty.

At low depths the effect is severe. With `chunks_per_bucket = 2^(depth - 16)`:
- depth 19 → 8 chunks/bucket. A 5 MB upload (~1280 chunks) is likely to drop 2 chunks in some bucket → **25% utilization for 5 MB**.
- depth 21 → 32 chunks/bucket. Same upload → ~9% utilization.
- depth 22 → 64 chunks/bucket. ~5%.

The displayed % is correct by Bee's definition but feels wildly wrong to users thinking in bytes.

## Decision

`SIZE_PRESETS` overbuys by 1–2 depths beyond what each label theoretically needs. Smaller labels overbuy more aggressively:

| Label | Depth | Effective | Overbuy |
|---|---|---|---|
| 110 MB | 21 | ~2.6 GB | 24× |
| 2.6 GB | 22 | ~7.7 GB | 3× |
| 7.7 GB | 23 | ~20 GB | 2.6× |
| 16 GB | 24 | ~47 GB | 3× |

`NOOK_DISPLAY_CAPACITY` keeps each depth mapped to its advertised label so `depthToBytes()` returns the user-facing capacity (not Bee's effective table) for both new and legacy stamps.

## Considered alternatives

1. **Match user-facing label to Bee's effective capacity (no overbuy)** — what Beeport does, what Nook did originally. At low depths the worst-case-bucket display is misleading; users complain "I uploaded 5 MB, why does it say 25%?"
2. **Drop small presets entirely (Bee Dashboard's choice)** — smallest stamp becomes 4 GB. Honest display, but kills the cheap "test drive" use case important for Nook's beta audience.
3. **Show only utilization % and hide "X MB used"** — UI-only fix, no cost change. Rejected because percentage alone is harder to reason about than "5 MB used".
4. **Show Nook's local upload-history sum as the "used" number** — accurate for Nook uploads but invisible to external uploads (swarm-cli, ACT chunks). Diverges from swarm-cli's display, making cross-tool comparison confusing.
5. **Uniform +2 depth overbuy across all sizes (initial attempt)** — applied evenly, large stamps become 4× more expensive without proportional UX benefit. Rejected after price comparison showed Nook's "2.6 GB" cost 2× Swarm Desktop's "4 GB" — clearly broken.

## Consequences

- Small drives (110 MB) cost ~6 BZZ/month instead of the theoretical ~1.5 BZZ. Still affordable; comparable to Swarm Desktop's smallest stamp.
- Capacity bars at small drives now register ~5–10% for a 5 MB upload (was 25%).
- Total cost grows roughly proportionally with advertised capacity, which feels right to users.
- Legacy depth-19 / depth-20 stamps purchased before this change continue to display correctly via `NOOK_DISPLAY_CAPACITY` legacy entries. Their bar will still look pessimistic at low fill — accepted as a known limitation rather than retroactively migrating.

## Source-of-truth note

We use Bee's `utilization` (matches swarm-cli, Bee Dashboard, beeport) as the source of truth for "how full is this stamp." Diverging from that to make small drives look prettier would mean Nook reports different fill than every other Swarm tool — rejected as confusing for power users.

The overbuy approach lets us keep that single source of truth while making the metric naturally cleaner via deeper buckets.
