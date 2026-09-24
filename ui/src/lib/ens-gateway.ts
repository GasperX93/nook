/**
 * Public gateway links for an ENS name (R4-8, R5-6).
 *
 * eth.limo appends `.limo` to the full name (`mzupan.eth` → `mzupan.eth.limo`)
 * and serves subnames too — it is the MAIN link (user decision, R5-6).
 *
 * bzz.link is the secondary link. Its certificate covers exactly ONE label
 * before `bzz.link` (`*.bzz.link`, verified), so:
 * - a simple name drops the `.eth`: `mzupan.eth` → `https://mzupan.bzz.link/`
 * - a subname can't be a host (`blog.mzupan.bzz.link` fails TLS) — use the
 *   path form instead: `https://bzz.link/bzz/blog.mzupan.eth/` (verified to
 *   serve the site). Never a 'Not secure' link.
 */
export function limoHost(ensName: string): string {
  return `${ensName}.limo`
}

export interface GatewayLink {
  url: string
  /** What to show — the URL without `https://` and the trailing slash. */
  label: string
}

export function bzzLink(ensName: string): GatewayLink | null {
  const name = ensName.trim().toLowerCase()

  if (!/^([a-z0-9-]+\.)+eth$/.test(name)) return null

  const single = /^([a-z0-9-]+)\.eth$/.exec(name)

  if (single) return { url: `https://${single[1]}.bzz.link/`, label: `${single[1]}.bzz.link` }

  return { url: `https://bzz.link/bzz/${name}/`, label: `bzz.link/bzz/${name}` }
}
