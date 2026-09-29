/**
 * Per-recipient send serialization.
 *
 * Each message goes to its own feed index, taken from a persisted
 * per-recipient cursor (`send-message.ts`). Two sends to the same recipient
 * running at once would both read the same cursor and collide on the same
 * index — one of the two messages is lost.
 *
 * Chaining sends per recipient makes each read-cursor → write → advance
 * complete before the next begins. Different recipients = different feeds and
 * cursors = no race, so they run independently.
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
