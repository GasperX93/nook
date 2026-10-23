import { getActState, setActState } from './drive-data'

/**
 * The app keeps each encrypted drive's latest ACT history ("head") and is the
 * only one that moves it.
 *
 * Bee (pkg/accesscontrol, v2.8.3): only grantee changes write a new history —
 * an encrypted upload given a history returns that same history
 * (controller.go:86-93). A grantee change built on an older head forks the
 * chain and the other branch's grant is lost. The dashboard used to carry the
 * head in React state and write back whatever an upload returned, so a grant
 * made while an upload ran was undone when the upload finished; two browsers
 * could fork it too.
 *
 * So every head writer runs here, one at a time per drive, on the head the
 * app stores — a head a browser sends is used only when the app has none yet
 * (a drive from before this). Grantee changes are also spaced ≥1.1 s apart:
 * Bee refuses a second change to the same history within one second
 * (controller.go:101-102).
 */

export interface ActBee {
  createGrantees(stampId: string, grantees: string[], historyRef?: string): Promise<{ ref: string; historyRef: string }>
  patchGrantees(
    stampId: string,
    granteeRef: string,
    historyRef: string,
    add?: string[],
    revoke?: string[],
  ): Promise<{ ref: string; historyRef: string }>
  /** ACT-encrypted /bytes upload, pushed directly (never deferred). */
  uploadActBytes(stampId: string, data: Buffer, historyRef?: string): Promise<{ reference: string; historyRef: string }>
}

const SAME_SECOND_GAP_MS = 1100
/** Heads a revoke left behind, kept to spot uploads that finished after it (drive-data.ts flagsRetiredHead). */
const MAX_RETIRED = 50

const queues = new Map<string, Promise<unknown>>()
const lastGranteeChange = new Map<string, number>()

async function withDriveLock<T>(batch: string, task: () => Promise<T>): Promise<T> {
  const tail = queues.get(batch) ?? Promise.resolve()
  const run = tail.then(task, task)

  queues.set(
    batch,
    run.catch((): undefined => undefined),
  )

  return run
}

async function waitSameSecondGap(batch: string): Promise<void> {
  const wait = (lastGranteeChange.get(batch) ?? 0) + SAME_SECOND_GAP_MS - Date.now()

  if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait))
}

function stored(batch: string): { head?: string; granteeRef?: string; heads?: string[]; retired?: string[] } {
  const meta = getActState(batch) ?? {}
  const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined)
  const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : undefined)

  return {
    head: str(meta.actHistoryRef),
    granteeRef: str(meta.granteeRef),
    heads: strings(meta.headsSinceRotation),
    retired: strings(meta.retiredHeads),
  }
}

/** Records the head a grantee change produced; a revoke retires every head of the old key. */
function recordGranteeChange(batch: string, before: string | undefined, ref: string, head: string, revoked: boolean) {
  const { heads, retired } = stored(batch)
  // Unknown history (a drive from before this): only the head we started from is known.
  const sinceRotation = heads ?? (before ? [before] : [])

  setActState(batch, {
    actHistoryRef: head,
    granteeRef: ref,
    ...(revoked
      ? {
          keyRotated: true,
          headsSinceRotation: [head],
          retiredHeads: [...(retired ?? []), ...sinceRotation].slice(-MAX_RETIRED),
        }
      : { headsSinceRotation: [...sinceRotation, head] }),
  })
  lastGranteeChange.set(batch, Date.now())
}

/** Grant access. Builds on the stored list and head; the browser's are only a fallback for old drives. */
export async function grantAccess(
  bee: ActBee,
  batch: string,
  grantees: string[],
  client: { historyRef?: string; granteeRef?: string },
): Promise<{ ref: string; historyRef: string }> {
  return withDriveLock(batch, async () => {
    await waitSameSecondGap(batch)
    const own = stored(batch)
    const head = own.head ?? client.historyRef
    const granteeRef = own.granteeRef ?? client.granteeRef
    // A list already exists → add to it; a second list on the same history would fork who has access.
    const result =
      granteeRef && head
        ? await bee.patchGrantees(batch, granteeRef, head, grantees)
        : await bee.createGrantees(batch, grantees, head)

    recordGranteeChange(batch, head, result.ref, result.historyRef, false)

    return result
  })
}

/** Add or remove access on the existing list. A removal rotates the drive's key (keyRotated). */
export async function changeAccess(
  bee: ActBee,
  batch: string,
  change: { add?: string[]; revoke?: string[] },
  client: { historyRef?: string; granteeRef?: string },
): Promise<{ ref: string; historyRef: string }> {
  return withDriveLock(batch, async () => {
    await waitSameSecondGap(batch)
    const own = stored(batch)
    const head = own.head ?? client.historyRef
    const granteeRef = own.granteeRef ?? client.granteeRef

    if (!head || !granteeRef) throw new Error('This drive has no access list yet')
    const result = await bee.patchGrantees(batch, granteeRef, head, change.add, change.revoke)

    recordGranteeChange(batch, head, result.ref, result.historyRef, Boolean(change.revoke?.length))

    return result
  })
}

/**
 * The drive's head for an encrypted upload or the shared file list. A drive
 * that has none gets one here, once, from a tiny encrypted upload — two
 * browsers starting a drive's first upload at once used to create two
 * histories with two keys. Call only once the drive is usable (Bee answers
 * 422 before that).
 */
export async function driveHead(bee: ActBee, batch: string, clientHistoryRef?: string): Promise<string> {
  return withDriveLock(batch, async () => {
    const own = stored(batch)

    if (own.head) return own.head

    // A drive from before this that the app hasn't learned yet: uploads don't
    // move the head, so use the browser's without adopting it.
    if (clientHistoryRef) return clientHistoryRef
    const { historyRef } = await bee.uploadActBytes(batch, Buffer.from('nook', 'utf-8'))

    if (!historyRef) throw new Error('Bee returned no ACT history')
    setActState(batch, { actHistoryRef: historyRef, headsSinceRotation: [historyRef] })

    return historyRef
  })
}

/** Encrypt the shared file list under the stored head (waits for any grant in progress). */
export async function uploadActMetadata(
  bee: ActBee,
  batch: string,
  data: Buffer,
  clientHistoryRef?: string,
): Promise<{ reference: string; historyRef: string }> {
  return withDriveLock(batch, async () => {
    const own = stored(batch)
    const result = await bee.uploadActBytes(batch, data, own.head ?? clientHistoryRef)

    // First ACT use of a drive from before this: whatever Bee settled on is the head now.
    if (!own.head && result.historyRef) setActState(batch, { actHistoryRef: result.historyRef })

    return result
  })
}

/** Tests only. */
export function resetActHeadState(): void {
  queues.clear()
  lastGranteeChange.clear()
}
