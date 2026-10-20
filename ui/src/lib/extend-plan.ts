/**
 * Extend drive math (test2 finding 2026-10-19). Bee 2.8.3 can lose a size
 * change on restart: the chain has the new depth, the node keeps stamping at
 * the old one (`/stamps` shows the old depth, `/batches` the chain's). Every
 * charge is made by the contract at the CHAIN depth, so cost, top-up and the
 * offered sizes must start from it — starting from Bee's depth charged twice
 * the shown price and re-sent a size change the chain had already made.
 */

const SECONDS_PER_MONTH = 30 * 86400
const SECONDS_PER_BLOCK = 5 // Gnosis chain

export interface ExtendInput {
  /** Depth Bee stamps at (`/stamps`). */
  beeDepth: number
  /** Depth on chain (`/batches`). */
  chainDepth: number
  /** Chosen size's depth, or null for time only. */
  targetDepth: number | null
  /** Remaining seconds (chain-derived). */
  batchTTL: number
  /** Extra months picked under "Extend duration" (0 for none). */
  extendMonths: number
  /** Price per chunk per block (PLUR), from chainstate. */
  currentPrice: string
}

export interface ExtendPlan {
  /** The depth the drive really has: the chain's, never less than Bee's. */
  baseDepth: number
  /** Bee still stamps at a smaller size than was paid for. */
  beeBehind: boolean
  willDilute: boolean
  depth: number
  /** Per-chunk amount to send with the top-up, or null when nothing to buy. */
  topupAmount: string | null
  /** What the contract will take, in PLUR, or null when nothing to buy. */
  totalPlur: bigint | null
}

export function extendPlan(input: ExtendInput): ExtendPlan {
  const baseDepth = Math.max(input.beeDepth, input.chainDepth)
  const depth = input.targetDepth !== null && input.targetDepth > baseDepth ? input.targetDepth : baseDepth
  const depthDelta = depth - baseDepth
  // Each +1 depth halves the remaining time; buy that half back, plus the
  // months the user asked for.
  const recoverySeconds = depthDelta > 0 ? Math.floor(input.batchTTL * (1 - 1 / 2 ** depthDelta)) : 0
  const totalSeconds = recoverySeconds + input.extendMonths * SECONDS_PER_MONTH
  const plan = { baseDepth, beeBehind: input.chainDepth > input.beeDepth, willDilute: depthDelta > 0, depth }

  if (totalSeconds <= 0) return { ...plan, topupAmount: null, totalPlur: null }

  const amount = BigInt(input.currentPrice) * BigInt(Math.floor(totalSeconds / SECONDS_PER_BLOCK))

  return {
    ...plan,
    // Top-up goes first, at the chain depth; the dilute after it halves the
    // per-chunk balance 2^delta times, so send that much more per chunk. The
    // contract charges topupAmount × 2^baseDepth = amount × 2^depth.
    topupAmount: (amount << BigInt(depthDelta)).toString(),
    totalPlur: amount << BigInt(depth),
  }
}
