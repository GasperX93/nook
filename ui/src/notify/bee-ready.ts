/**
 * Wait until the Bee node is READY (not just health-ok).
 *
 * /health is 'ok' as soon as the API is up, but the node can't reliably push
 * chunks to the network until warmup completes (~tens of seconds after launch/
 * restart). A message sent during that window gets a local write (and a local
 * read-back ✓) but never propagates to the recipient — observed as a single
 * message silently not arriving right after relaunch.
 *
 * Gating sends on /readiness === 'ready' holds the message until the node can
 * actually deliver it.
 */
import { beeApi } from '../api/bee'

export async function waitForBeeReady(opts: { timeoutMs?: number; intervalMs?: number } = {}): Promise<boolean> {
  const timeoutMs = opts.timeoutMs ?? 20_000
  const intervalMs = opts.intervalMs ?? 1_500
  const deadline = Date.now() + timeoutMs

  for (;;) {
    try {
      const r = await beeApi.readiness()

      if (r?.status === 'ready') return true
    } catch {
      // starting / not reachable yet — keep waiting
    }

    if (Date.now() >= deadline) return false
    await new Promise(resolve => setTimeout(resolve, intervalMs))
  }
}
