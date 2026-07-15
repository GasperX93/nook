/**
 * fetch with a hard deadline (#94 part B). Bare `fetch()` in the main process
 * has no timeout — a hung Bee or network leaves requests pending forever.
 */
export async function fetchWithTimeout(url: string, options: RequestInit = {}, timeoutMs = 10_000): Promise<Response> {
  return fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) })
}
