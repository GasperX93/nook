/**
 * System stamp helpers (#130) — the reserved network space for identity &
 * messages, bought server-side and labeled `nook-system`.
 *
 * UI rules: hidden from the Drive list; identity/messaging writes prefer it
 * over drive batches (the old first-usable-batch hijack becomes the graceful
 * fallback); Settings shows it as "Identity & messages".
 */

export const SYSTEM_STAMP_LABEL = 'nook-system'

interface StampLike {
  batchID: string
  usable: boolean
  label?: string
}

export function isSystemStamp(stamp: { label?: string }): boolean {
  return stamp.label === SYSTEM_STAMP_LABEL
}

export interface MessagingStampPick {
  batchID: string
  /** True when falling back to a drive batch — the reserved space is missing/unusable. */
  degraded: boolean
}

/**
 * The batch identity publishing and message sends should use.
 * Chain: system batch → any usable non-reclaimable batch (degraded) → null.
 * Reclaimable batches must be excluded — their slots are ledger-managed and
 * Bee-stamped writes to them are refused (poison guards, #99).
 */
export function pickMessagingStamp(
  stamps: StampLike[] | undefined,
  reclaimableIds?: Set<string>,
): MessagingStampPick | null {
  const candidates = (stamps ?? []).filter(s => s.usable && !(reclaimableIds?.has(s.batchID.toLowerCase()) ?? false))
  const system = candidates.find(isSystemStamp)

  if (system) return { batchID: system.batchID, degraded: false }
  const fallback = candidates.find(s => !isSystemStamp(s))

  return fallback ? { batchID: fallback.batchID, degraded: true } : null
}
