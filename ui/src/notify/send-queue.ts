/**
 * Per-feed mailbox send serialization.
 *
 * mailbox.send does a read-modify-write of the WHOLE message array on a single
 * feed (read existing → append → re-upload → repoint feed). Two rapid sends to
 * the same recipient race: the second reads the array before the first's feed
 * update lands, appends to the stale copy, and overwrites the first → the
 * earlier message is silently lost.
 *
 * Chaining sends per recipient (the feed is sender→recipient, sender fixed)
 * makes each read-modify-write complete before the next begins, so appends
 * stack instead of clobbering. Different recipients = different feeds = no race,
 * so they run independently.
 */
const chains = new Map<string, Promise<unknown>>()

export async function enqueueSend<T>(recipientId: string, fn: () => Promise<T>): Promise<T> {
  const key = recipientId.toLowerCase()
  const prev = chains.get(key) ?? Promise.resolve()
  // Run after the previous send settles, regardless of whether it resolved or
  // rejected — one failed send must not stall the queue.
  const run = prev.then(fn, fn)

  // Keep the chain pointer alive but swallow its outcome so the next send isn't
  // affected by this one's result/error. The caller still gets the real `run`.
  chains.set(
    key,
    run.then(
      () => undefined,
      () => undefined,
    ),
  )

  return run
}
