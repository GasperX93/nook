/**
 * One vocabulary for transfer states (R4-11, R4-14), so rows, cards and the
 * sidebar all say the same thing.
 *
 * Downloads: the file is fetched into memory with progress, then handed to
 * the browser — building a large file can take seconds after the last byte,
 * so 100% reads "Preparing file…" rather than looking finished or stuck.
 *
 * Uploads (classic drives) happen in two steps the user should be able to
 * tell apart: copying into the local Bee node, then storing on the network.
 */
export function savingLabel(pct: number): string {
  if (pct >= 100) return 'Preparing file…'

  return pct > 0 ? `Saving ${pct}%` : 'Preparing…'
}

export const UPLOAD_STEP_LOCAL = 'Step 1 of 2 · Copying to your Bee node'
export const UPLOAD_STEP_NETWORK = 'Step 2 of 2 · Storing on the Swarm network'

/** Encrypted uploads are pushed straight to the network — one step, no local stage. */
export const UPLOAD_ENCRYPTED = 'Encrypting & storing on the network…'
