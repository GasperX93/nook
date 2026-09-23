/**
 * Public gateway hostnames for an ENS name (R4-8).
 *
 * eth.limo appends `.limo` to the full name (`mzupan.eth` → `mzupan.eth.limo`)
 * and serves subnames too. bzz.link drops the `.eth` (`mzupan.eth` →
 * `mzupan.bzz.link`): its certificate covers ONE label before `bzz.link`, so
 * `mzupan.eth.bzz.link` fails with a certificate error, and so would any
 * subname (`blog.mzupan.eth`). For those there is no bzz.link address.
 */
export function limoHost(ensName: string): string {
  return `${ensName}.limo`
}

export function bzzLinkHost(ensName: string): string | null {
  const match = /^([a-z0-9-]+)\.eth$/i.exec(ensName.trim())

  return match ? `${match[1].toLowerCase()}.bzz.link` : null
}
