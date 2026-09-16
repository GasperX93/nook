import { existsSync, readFileSync, writeFileSync } from 'fs'

import { logger } from './logger'
import { getPath } from './path'

/**
 * Purchases ledger (#139) — Nook's record of the drive operations IT executed
 * that move BZZ on-chain: buying a batch and topping one up. Each record
 * carries the exact PLUR amount the postage contract charged, so the wallet
 * Activity list can match the on-chain transfer back to the drive by name
 * ("New drive · Photos") instead of the generic contract label.
 *
 * This is observation, not bookkeeping-as-truth: rows are written only after
 * the operation succeeded, and the Activity list still shows every on-chain
 * transfer whether or not a record exists — an unmatched payment simply keeps
 * its generic label. Dilution is deliberately absent: it redistributes the
 * batch's existing balance and moves no BZZ.
 */

export interface PurchaseRecord {
  /** Unix ms */
  at: number
  kind: 'create' | 'topup'
  batchId: string
  /** Drive name at the time of the operation */
  label?: string
  /** Exact cost: amount-per-chunk × 2^depth */
  amountPlur: string
}

const STORE_FILE = 'purchases.json'

/** Plenty for matching the explorer's 50-row window, bounded forever. */
const MAX_PURCHASES = 200

export function loadPurchases(): PurchaseRecord[] {
  try {
    if (!existsSync(getPath(STORE_FILE))) return []
    const data = JSON.parse(readFileSync(getPath(STORE_FILE), 'utf-8')) as PurchaseRecord[]

    return Array.isArray(data) ? data : []
  } catch (error) {
    logger.error(`purchases ledger unreadable: ${error}`)

    return []
  }
}

export function recordPurchase(record: Omit<PurchaseRecord, 'at'>): void {
  try {
    const updated = [{ at: Date.now(), ...record }, ...loadPurchases()].slice(0, MAX_PURCHASES)

    writeFileSync(getPath(STORE_FILE), JSON.stringify(updated, null, 2))
    logger.info(`purchase recorded: ${record.kind} ${record.batchId.slice(0, 8)} (${record.amountPlur} PLUR)`)
  } catch (error) {
    // Never let bookkeeping break the purchase that already succeeded.
    logger.error(`purchase record failed: ${error}`)
  }
}

/** Exact on-chain cost of a batch create/topup: per-chunk amount × 2^depth. */
export function purchaseCostPlur(amountPerChunk: string, depth: number): string {
  return (BigInt(amountPerChunk) << BigInt(depth)).toString()
}
